/**
 * One turn on an agent CLI: attach OpenBOT's tools, then run it under an
 * inactivity clock.
 *
 * Split out of `turnDriver` because both halves are about the CLI rather than
 * about turn-taking — the driver only needs to know that a supervised turn
 * comes back as an ordinary `TurnResult`.
 */

import type { Bot, Session, Settings } from '../../shared/types'
import * as cancel from './cancel'
import { addNotice } from './messages'
import { attachGateway } from './mcpGateway'
import { broadcastError } from './events'
import { startIdleClock } from './idleClock'
import { SUPERVISED_IDLE_TIMEOUT_MS, supervisedTimeoutMessage } from './backendMode'
import { runTurn, type TurnResult } from './turn'
import { traceChatTiming } from '../backends/chatTiming'

export interface SupervisedTurnInput {
  session: Session
  bot: Bot
  settings: Settings
  signal: AbortSignal
  extras: string[]
  replyTo: string | null
  floor: string | null
  retry: boolean
  internalAssistant?: boolean
}

/**
 * Run a supervised turn.
 *
 * The gateway is attached first and its endpoint travels with the request, so
 * the CLI is handed OpenBOT's tools on its own command line for this turn
 * rather than through anything written to the user's config. A backend that
 * cannot take a server at run time gets none, and no listener is opened for it.
 *
 * The turn is then bounded by SILENCE, not by how long it takes. One timer
 * around the whole turn killed a CLI that had been streaming steadily for
 * twenty minutes — an ordinary long refactor, not a hang — and then told the
 * user it had produced nothing. Every chunk rearms the clock, so what it
 * catches is the case it was always meant to: a process that has stopped
 * saying anything at all.
 */
export async function runSupervisedTurn(input: SupervisedTurnInput): Promise<TurnResult> {
  const { session, bot } = input
  traceChatTiming(session.id, 'gateway-start')
  // Attach while the turn resolves the model, context and skills. The request
  // still waits for the gateway before starting the CLI.
  const gateway = attachGateway({
    sessionId: session.id,
    botId: bot.id,
    cwd: session.cwd,
    backendId: bot.backendId
  }).then((value) => { traceChatTiming(session.id, 'gateway-ready'); return value })

  const clock = startIdleClock(SUPERVISED_IDLE_TIMEOUT_MS, () => {
    // Aborting the session's controller is what kills the CLI's child process.
    cancel.abort(session.id, 'agent CLI turn timed out')
  })

  try {
    const result = await runTurn({
      session,
      bot,
      settings: input.settings,
      signal: input.signal,
      extras: input.extras,
      replyTo: input.replyTo,
      floor: input.floor,
      retry: input.retry,
      internalAssistant: input.internalAssistant,
      gateway,
      onActivity: clock.touch
    })
    if (clock.expired()) {
      const message = supervisedTimeoutMessage()
      await addNotice(session, bot, message, 'timeout')
      broadcastError(session.id, message)
    }
    return result
  } finally {
    // Finish attachment before the caller schedules gateway cleanup even if
    // the turn fails early (for example, an unavailable backend).
    await gateway
    clock.stop()
  }
}
