/**
 * Runs turns until one finishes the work.
 *
 *   resolve the active bot and its backend mode
 *     → orchestrated: take an iteration from the cap, then runTurn
 *       supervised:   hand off to `supervisedTurn`, which attaches the MCP
 *                     gateway and bounds the turn by inactivity
 *     → 'tools'   : results were appended, iterate again
 *       'handoff' : the active bot changed, iterate as the receiving bot
 *       'final'   : extract memory, stop
 *       'aborted' / 'error' : stop cleanly
 *
 * In a multi-bot session this is also the moderator: it hands the floor to one
 * bot at a time, states the goal, and is the only thing that decides who speaks
 * next. Left to sort that out between themselves the bots drift into greetings.
 *
 * A backend or tool failure never breaks out of here — it becomes an `error`
 * event and a clean end of turn.
 */

import type { Bot, Session } from '../../shared/types'
import * as limits from './limits'
import { actionNudge, floorBrief, goalOf, lastUserMessage } from './exchangeBrief'
import { addressedBot, mentionsBot } from './exchange'
import { carryAfterHandoff, carryAfterNudge } from './turnCarry'
import { addNotice } from './messages'
import { cancelGatewayDetach, detachGateway, scheduleGatewayDetach } from './mcpGateway'
import { bots, sessions } from './sessionGateway'
import { broadcastError } from './events'
import { extractAfterTurn } from './memory'
import { getBackendInfo } from './backendGateway'
import { modeFor } from './backendMode'
import { runSupervisedTurn } from './supervisedTurn'
import { runTurn, type TurnResult } from './turn'
import { settingsStore } from './settingsGateway'

/** How many times per user message the moderator will ask for a missing ACTION line. */
const MAX_ACTION_NUDGES = 1

/**
 * Run turns until one finishes the work.
 *
 * Owns the MCP gateway for the run: whatever it attached is detached on the way out,
 * including when a turn throws. Leaving that to the caller lost the detach on the
 * throwing path, and the gateway's server for that session then outlived the run.
 */
export async function iterate(session: Session, signal: AbortSignal): Promise<void> {
  // A follow-up message must not find the gateway already revoked. The detach
  // is deferred when the previous turn ended so a warm CLI can keep its token.
  cancelGatewayDetach(session.id)
  let sawSupervised = false
  try {
    await runTurns(session, signal, () => {
      sawSupervised = true
    })
  } finally {
    if (sawSupervised) scheduleGatewayDetach(session.id)
    else void detachGateway(session.id)
  }
}

async function runTurns(
  session: Session,
  signal: AbortSignal,
  noteSupervised: () => void
): Promise<void> {
  let extras: string[] = []
  let bot: Bot | null = null
  // Exchange bookkeeping: which turn we are on, and the message being answered.
  let turn = 1
  let replyTo: string | null = null
  let handedFrom: string | undefined
  let handedRequest: string | undefined

  // In a multi-bot session the moderator briefs EVERY turn, including the first.
  // Briefing only on handover left the opening turn with nothing but the system
  // prompt, which local models routinely ignore — so no one ever took the floor.
  const roster = await bots.many(session.botIds ?? [])
  const isExchange = roster.length > 1
  /*
   * Set only when the user's message opened with "@Name": that bot must answer
   * them. Reading `session.activeBotId` instead would be true of whoever merely
   * holds the floor, so every opening turn would be told the user asked for it
   * personally and to keep its teammates out of it.
   *
   * Cleared the moment the floor moves. Held for the whole run it outlived the
   * turn it described: after a handover and a hand back, the addressed bot was
   * told all over again that "the user asked you directly — answer them, not
   * your teammates", and the teammate's actual question — which the brief only
   * carries on the other branch — never reached it.
   */
  let addressed = isExchange ? (addressedBot(lastUserMessage(session), roster)?.id ?? null) : null
  /*
   * A reply that leaves work with a teammate but never names them costs the user
   * a dead conversation. The moderator asks for the line once per user message,
   * then the turn ends either way — one forgotten line is one extra model call,
   * never a loop. Holds the nudge text for the retry turn.
   */
  let nudge: string | null = null
  let nudgesLeft = MAX_ACTION_NUDGES

  while (!signal.aborted) {
    bot = await resolveBot(session)
    if (!bot) {
      broadcastError(
        session.id,
        'No bot is available for this session. Add one to it before sending a message.'
      )
      return
    }
    const speaker = bot
    const teammates = roster.filter((other) => other.id !== speaker.id).map((other) => other.name)

    const mode = modeFor(await getBackendInfo(bot.backendId), bot.computerTarget)
    const settings = await settingsStore.get()

    if (mode === 'supervised' && bot.computerTarget?.kind === 'vm') {
      const message =
        `Backend "${bot.backendId}" is an agent CLI, but VM ${bot.computerTarget.vmId} does not ` +
        'support model-only VM orchestration. BlinkyBot refused to give that CLI access to this Mac. ' +
        'Choose a VM-compatible backend or explicitly switch the bot to This Mac.'
      await addNotice(session, bot, message)
      broadcastError(session.id, message)
      return
    }

    // The iteration cap governs the loop we drive. A CLI owns its own iteration, so it
    // is bounded by how long it goes quiet for instead.
    if (mode === 'orchestrated' && !limits.takeIteration(session.id)) {
      const message = limits.iterationCapMessage(session.id)
      await addNotice(session, bot, message)
      broadcastError(session.id, message)
      return
    }

    const floor = !isExchange
      ? null
      : (nudge ??
        floorBrief({
          goal: goalOf(session),
          speaker: bot.name,
          from: handedFrom,
          request: handedRequest,
          userAddressed: addressed === bot.id,
          turn,
          remaining: limits.handoffsLeft(session.id)
        }))
    const retry = nudge !== null
    nudge = null

    /*
     * What this turn was handed. Kept, because a nudged turn is the SAME turn
     * asked again: clearing the incoming handoff note before the nudge check
     * meant the retry ran without it, so a bot that was nudged forgot what its
     * teammate had asked it.
     */
    const given: { extras: string[]; replyTo: string | null } = { extras, replyTo }
    extras = []
    replyTo = null
    handedFrom = undefined
    handedRequest = undefined

    let result: TurnResult
    if (mode === 'supervised') {
      noteSupervised()
      result = await runSupervisedTurn({
        session,
        bot,
        settings,
        signal,
        extras: given.extras,
        replyTo: given.replyTo,
        floor,
        retry
      })
    } else {
      result = await runTurn({
        session,
        bot,
        settings,
        signal,
        extras: given.extras,
        replyTo: given.replyTo,
        floor,
        retry
      })
    }

    /*
     * The bot discussed a teammate but never said who goes next. Ask for the line
     * and let it try again, keeping the floor where it is: this is not a handoff,
     * so it costs nothing from the ping-pong budget.
     *
     * A reply that mentions nobody is not a protocol failure — it is an answer to
     * the user, complete as it stands, and re-running the bot for it only makes
     * the user read a second version of the same reply.
     */
    if (
      result.status === 'final' &&
      result.actionMissing &&
      nudgesLeft > 0 &&
      mentionsBot(result.message.content, teammates)
    ) {
      nudgesLeft -= 1
      nudge = actionNudge(speaker.name, teammates)
      // The retry is this same turn, so it answers the same handoff note.
      ;({ extras, replyTo, addressed } = carryAfterNudge(given, addressed))
      continue
    }

    if (result.status === 'handoff') {
      // Continue as the receiving bot, with the moderator restating the goal.
      turn += 1
      handedFrom = bot.name
      handedRequest = result.request?.trim() || undefined
      /*
       * The floor has moved, so "the user asked YOU directly" is no longer true
       * of anyone; from here the brief carries the teammate's question instead.
       * The note goes to the system prompt — only the ask itself belongs in the
       * moderator's line, or the whole brief is quoted back inside it.
       */
      ;({ extras, replyTo, addressed } = carryAfterHandoff(result.note, result.message.id))
      continue
    }
    if (result.status === 'tools') continue
    if (result.status === 'aborted' || result.status === 'error') return

    // A turn that ended by answering clears the ping-pong budget.
    limits.clearHandoffs(session.id)
    // Detached on purpose — it must not delay the reply — but it now registers
    // itself so stopping the session or quitting the app actually reaches it.
    void extractAfterTurn(session, bot, settings, mode)
    return
  }
}

/**
 * The active bot, falling back to the session's first surviving participant.
 *
 * Refreshed from the store first: a supervised CLI hands off through the MCP gateway,
 * which moves `activeBotId` behind our back, and the copy this loop has been holding
 * since the turn began would otherwise send the floor straight back to the same bot.
 */
async function resolveBot(session: Session): Promise<Bot | null> {
  await sessions.refresh(session)

  const active = session.activeBotId ? await bots.get(session.activeBotId) : null
  if (active) return active

  for (const id of session.botIds ?? []) {
    const bot = await bots.get(id)
    if (!bot) continue
    await sessions.update(session, (fresh) => {
      fresh.activeBotId = bot.id
    })
    return bot
  }
  return null
}
