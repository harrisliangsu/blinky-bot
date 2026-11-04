/**
 * One model round-trip: build the context, stream the reply, and — when we own the loop —
 * run whatever tools it asked for.
 *
 * The outer iteration and its caps belong to `loop.ts`. This module only describes the
 * outcome of a single turn; it never decides to keep going.
 *
 * In `supervised` mode the backend is an agent CLI running its own loop: it executes its
 * own tools and its adapter renders that as text, so there is nothing here to execute and
 * the turn always ends after one pass.
 *
 * The pieces of a turn live beside it: `chatRequest.ts` assembles the backend request,
 * `turnAction.ts` reads the multi-bot ACTION line, `calls.ts` runs the tool calls, and
 * `turnTypes.ts` holds the shapes. All of them are re-exported from here.
 */

import {
  backendStartBlock,
  explainStartupFailure,
  unavailableBackendMessage
} from '../../shared/backendPrompt'
import type { Message, Session } from '../../shared/types'
import { assistantMessage, begin, commit } from './messages'
import {
  backendConfigFor,
  detectBackends,
  getBackend,
  getModelInfo,
  openChatStream
} from './backendGateway'
import { broadcastError } from './events'
import { buildChatRequest } from './chatRequest'
import { buildContext } from './context'
import { collapseRepeatedLines } from './repetition'
import { errorMessage, isAbortError } from './errors'
import { mergeBuiltins } from './builtins'
import { memoryStore } from './memoryGateway'
import { modeFor, type TurnMode } from './backendMode'
import { noteGatewayMessage } from './mcpGateway'
import { applyAction, readAction } from './turnAction'
import { takePendingNote } from './handoff'
import { bots } from './sessionGateway'
import { runCalls } from './calls'
import { schemasFor } from './toolGateway'
import { skillsSection } from './skillsGateway'
import { streamAssistantTurn } from './stream'
import { isEmptyTurn } from './turnCarry'

export type { TurnStatus, TurnInput, TurnResult } from './turnTypes'
import type { TurnInput, TurnResult } from './turnTypes'

export async function runTurn(input: TurnInput): Promise<TurnResult> {
  const { session, bot, settings, signal } = input
  const message = assistantMessage(bot)
  // Links this reply back to the teammate message that prompted it.
  if (input.replyTo) message.replyTo = input.replyTo

  const infos = await detectBackends()
  const info = infos.find((item) => item.id === bot.backendId) ?? null
  const mode = modeFor(info, bot.computerTarget)
  const blocked = backendStartBlock(info, infos, bot.backendId)
  if (blocked) return failTurn(session, message, mode, blocked, false)

  const backend = await getBackend(bot.backendId)
  if (!backend) {
    return failTurn(
      session,
      message,
      mode,
      unavailableBackendMessage({
        label: info?.label ?? bot.backendId,
        nothingReady: !infos.some((item) => item.status === 'available')
      }),
      false
    )
  }

  const model = await getModelInfo(bot.backendId, bot.modelId)
  /*
   * Assigned skills are described last, after the handoff note and any routine
   * brief, so a skill can never talk over the instruction that started the turn.
   * Resolution reads disk (cached), which is why it happens here rather than in
   * the synchronous prompt composer.
   */
  const skills = await skillsSection(bot, session)
  const context = buildContext({
    session,
    bot,
    settings,
    memory: await memoryStore.list(bot.id),
    schemas: mergeBuiltins(await schemasFor(bot.tools ?? [], bot.computerTarget), bot.tools ?? []),
    roster: await bots.many(session.botIds ?? []),
    contextWindow: model?.contextWindow,
    supportsVision: model?.supportsVision === true,
    extras: skills ? [...(input.extras ?? []), skills] : input.extras
  })

  /*
   * The moderator hands over the floor as a USER turn rather than a system
   * section. Instruction-following collapses with distance from the generation
   * point: the same words in a system prompt get ignored by local models, but
   * as the final user message they are obeyed. This is how the reference
   * implementation drives its rooms too.
   */
  if (input.floor) {
    context.messages.push({ role: 'user', content: input.floor })
  }

  begin(session.id, message)
  /*
   * A CLI calling one of OUR tools through the gateway emits a `tool-call`
   * event, and an event needs a message to hang off. The message only exists
   * now — after the gateway was attached — so the gateway is told about it
   * here, or the CLI's use of our tools never shows up in the transcript.
   */
  if (mode === 'supervised') void noteGatewayMessage(session.id, message.id)

  let streamed
  try {
    const stream = await openChatStream(
      backend,
      buildChatRequest({
        session,
        bot,
        settings,
        signal,
        mode,
        messages: context.messages,
        tools: context.tools,
        gateway: input.gateway
      }),
      backendConfigFor(settings, bot.backendId)
    )
    streamed = await streamAssistantTurn({
      sessionId: session.id,
      messageId: message.id,
      stream,
      signal,
      contextWindow: model?.contextWindow,
      onActivity: input.onActivity
    })
  } catch (err) {
    if (isAbortError(err) || signal.aborted) {
      await commit(session, message)
      return { status: 'aborted', message, mode }
    }
    const raw = errorMessage(err)
    return failTurn(
      session,
      message,
      mode,
      explainStartupFailure(
        raw,
        unavailableBackendMessage({
          label: info?.label ?? bot.backendId,
          nothingReady: !infos.some((item) => item.status === 'available')
        }),
        `${bot.name} could not reach the model: ${raw}`
      ),
      true
    )
  }

  /*
   * An agent CLI emits one text block per iteration of its own tool loop and we
   * concatenate them, so a model that opens every iteration the same way lands
   * that sentence in the transcript several times over. Collapse before parsing,
   * so the ACTION line is found even when the stutter reached the end.
   */
  const reply = collapseRepeatedLines(streamed.text)

  const live = !streamed.aborted && !signal.aborted
  message.content = reply

  /*
   * The stream broke partway. What arrived first is kept — it is already on
   * screen, and a CLI that answers and then hits its quota has said something
   * real — but the turn is reported as the failure it was. Accepting it
   * silently is how a truncated answer reaches the user looking complete.
   */
  if (live && streamed.error !== undefined) {
    const raw = errorMessage(streamed.error)
    const detail = explainStartupFailure(
      raw,
      unavailableBackendMessage({
        label: info?.label ?? bot.backendId,
        nothingReady: !infos.some((item) => item.status === 'available')
      }),
      `${bot.name} stopped early: ${raw}`
    )
    return failTurn(session, message, mode, detail, true)
  }

  /*
   * Nothing came back at all: no text, no reasoning, no tool call. Committing
   * that left an empty assistant bubble with no explanation, which reads as the
   * app having lost the reply rather than the model having produced none.
   */
  if (live && isEmptyTurn(reply, streamed.reasoning, streamed.calls.length)) {
    const detail =
      `${bot.name} produced an empty reply — the model returned nothing at all. ` +
      'Send the message again, or try a different model for this bot.'
    return failTurn(session, message, mode, detail, true)
  }

  const read = await readAction(session, reply)
  message.content = read.content
  message.reasoning = streamed.reasoning || undefined
  message.toolCalls = streamed.calls.length ? streamed.calls : undefined
  await commit(session, message)

  if (streamed.aborted || signal.aborted) return { status: 'aborted', message, mode }

  const handed = await applyAction(input, read, message, mode)
  if (handed) return handed

  if (mode === 'supervised') {
    // The CLI already ran everything it needed; the only thing that can carry over is a
    // handoff it made through the gateway.
    const note = takePendingNote(session.id)
    if (note) return { status: 'handoff', message, mode, note }
    return { status: 'final', message, mode, actionMissing: read.actionMissing }
  }

  if (streamed.calls.length === 0) {
    return { status: 'final', message, mode, actionMissing: read.actionMissing }
  }
  return runCalls(input, message, reply, mode)
}

/**
 * End the turn with a clean failure: the assistant message carries the explanation and
 * the renderer gets an `error` event. `started` says whether `message-start` already went
 * out, so the pair is never announced twice.
 */
async function failTurn(
  session: Session,
  message: Message,
  mode: TurnMode,
  detail: string,
  started: boolean
): Promise<TurnResult> {
  message.content = message.content ? `${message.content}\n\n${detail}` : detail
  message.error = detail
  broadcastError(session.id, detail)
  if (!started) begin(session.id, message)
  await commit(session, message)
  return { status: 'error', message, mode }
}
