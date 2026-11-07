import { taskProgressContext } from '../tasks/progressObservations'
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
  chatStartBlock,
  explainStartupFailure,
  unavailableBackendMessage
} from '../../shared/backendPrompt'
import type { Message, Session } from '../../shared/types'
import { assistantMessage, begin, commit } from './messages'
import { scrubVaultMessage } from '../store/vaultPrivacy'
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
import { requireRuntimeMcpServer } from './runtimeMcp'
import { applyAction, readAction } from './turnAction'
import { takePendingNote } from './handoff'
import { bots, sessions } from './sessionGateway'
import { isExecutionAgent, isTracedBackgroundRun } from './executionAgent'
import { flushAll } from '../store/jsonStore'
import { applyBotBinding } from '../store/bots'
import { hydrateRecentImages } from '../store/sessions'
import { runCalls } from './calls'
import { schemasFor } from './toolGateway'
import { skillsSection } from './skillsGateway'
import { streamAssistantTurn } from './stream'
import { isEmptyTurn } from './turnCarry'
import { backendSeesImages } from '../backends/cli/cliImages'
import { listTasks } from '../store/tasks'
import { traceChatTiming } from '../backends/chatTiming'

export type { TurnStatus, TurnInput, TurnResult } from './turnTypes'
import type { TurnInput, TurnResult } from './turnTypes'

export async function runTurn(input: TurnInput): Promise<TurnResult> {
  const { session, settings, signal } = input
  // The driver already resolved the private execution agent. Never persist
  // that temporary model or its inferred thinking depth onto the lead Bot.
  const bot = isExecutionAgent(session.id) ? input.bot : applyBotBinding(input.bot)
  const existingTasks = new Set(listTasks().filter((task) => task.sourceSessionId === session.id).map((task) => task.id))
  const existingReviews = new Set(listTasks().filter((task) => task.sourceSessionId === session.id && task.review).map((task) => task.id))
  const message = assistantMessage(bot)
  const timing = (stage: string): void => traceChatTiming(session.id, stage, message.id)
  timing('turn-start')
  if (input.internalAssistant) message.internal = true
  // Links this reply back to the teammate message that prompted it.
  if (input.replyTo) message.replyTo = input.replyTo

  timing('backend-info-start')
  const infos = await detectBackends()
  timing('backend-info-ready')
  const info = infos.find((item) => item.id === bot.backendId) ?? null
  const mode = modeFor(info, bot.computerTarget)
  const blocked = chatStartBlock(info, infos, bot.backendId, settings.language)
  if (blocked) return failTurn(session, message, mode, blocked, false)

  const backend = await getBackend(bot.backendId)
  if (!backend) {
    return failTurn(
      session,
      message,
      mode,
      unavailableBackendMessage({
        label: info?.label ?? bot.backendId,
        nothingReady: !infos.some((item) => item.status === 'available'),
        language: settings.language
      }),
      false
    )
  }

  // Open the message lifecycle before startup work, without inventing text.
  // The renderer waits for public model content before showing a reply.
  const checkpointExecution = isTracedBackgroundRun(session.id)
  if (checkpointExecution) {
    const inserted = await sessions.update(session, (fresh) => { fresh.messages.push(structuredClone(message)) })
    const saved = inserted ? await flushAll() : null
    if (!inserted || !saved || saved.failed.length || saved.stillWriting) return failTurn(session, message, mode, 'The execution transcript could not be saved; the agent was not started.', false)
  }
  begin(session.id, message)

  let streamed
  try {
    /*
     * Assigned skills are described last, after the handoff note and any routine
     * brief, so a skill can never talk over the instruction that started the turn.
     * Resolution reads disk (cached), which is why it happens here rather than in
     * the synchronous prompt composer. None of these reads depend on each other.
     */
    timing('context-start')
    timing('model-info-start')
    const [model, skills, memory, schemas, roster] = await Promise.all([
      getModelInfo(bot.backendId, bot.modelId).then((value) => { timing('model-info-ready'); return value }),
      skillsSection(bot, session),
      memoryStore.list(bot.id),
      schemasFor(bot.tools ?? [], bot.computerTarget),
      bots.many(session.botIds ?? [])
    ])
    const supportsVision = backendSeesImages(bot.backendId, model)
    const context = buildContext({
      session: hydrateRecentImages(checkpointExecution ? { ...session, messages: session.messages.filter((item) => item.id !== message.id) } : session),
      bot,
      settings,
      memory,
      schemas: mergeBuiltins(schemas, bot.tools ?? []),
      roster,
      contextWindow: model?.contextWindow,
      supportsVision,
      extras: [...(input.extras ?? []), skills, taskProgressContext(session.id, bot.id)].filter((value): value is string => Boolean(value))
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
    timing('context-ready')

    const attachedGateway = await input.gateway
    const gateway = mode === 'supervised' ? requireRuntimeMcpServer(bot.backendId, attachedGateway) : attachedGateway
    if (signal.aborted) throw signal.reason ?? new Error('Turn cancelled')
    if (mode === 'supervised' && gateway) await noteGatewayMessage(session.id, message.id)
    const stream = await openChatStream(
      backend,
      { ...buildChatRequest({
        session,
        bot,
        settings,
        signal,
        mode,
        messages: context.messages,
        supportsVision,
        tools: context.tools,
        gateway: gateway ?? undefined
      }), onTiming: (stage) => timing(stage) },
      backendConfigFor(settings, bot.backendId)
    )
    timing('adapter-open')
    streamed = await streamAssistantTurn({
      sessionId: session.id,
      messageId: message.id,
      stream,
      signal,
      contextWindow: model?.contextWindow,
      onActivity: input.onActivity,
      onTiming: (stage) => timing(stage),
      ...(checkpointExecution ? { onCheckpoint: async (partial: { text: string; reasoning: string; calls: NonNullable<Message['toolCalls']>; agentTrace: NonNullable<Message['agentTrace']> }) => {
        const snapshot: Message = scrubVaultMessage({ ...message, content: partial.text, ...(partial.reasoning ? { reasoning: partial.reasoning } : {}), ...(partial.calls.length ? { toolCalls: partial.calls } : {}), ...(partial.agentTrace.length ? { agentTrace: partial.agentTrace } : {}) })
        const updated = await sessions.update(session, (fresh) => { const at = fresh.messages.findIndex((item) => item.id === message.id); if (at >= 0) fresh.messages[at] = snapshot })
        if (!updated) throw new Error('Execution session unavailable.')
        const saved = await flushAll()
        if (saved.failed.length || saved.stillWriting) throw new Error('Execution checkpoint failed.')
      } } : {})
    })
  } catch (err) {
    if (isAbortError(err) || signal.aborted) {
      if (signal.reason instanceof Error && signal.reason.message === 'superseded by user follow-up') message.internal = true
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
          nothingReady: !infos.some((item) => item.status === 'available'),
          language: settings.language
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
  if (streamed.agentTrace?.length) message.agentTrace = streamed.agentTrace

  const live = !streamed.aborted && !signal.aborted
  message.content = reply
  // Keep public phase boundaries even on failure or stop. Otherwise a failed
  // stream is replayed as undifferentiated text when the session is reopened.
  message.segments = streamed.segments
  message.reasoning = streamed.reasoning || undefined
  message.toolCalls = streamed.calls.length ? streamed.calls : undefined
  if (streamed.displayText !== undefined) message.displayContent = streamed.displayText
  if (signal.aborted && signal.reason instanceof Error && signal.reason.message === 'superseded by user follow-up') message.internal = true

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
        nothingReady: !infos.some((item) => item.status === 'available'),
        language: settings.language
      }),
      `${bot.name} stopped early: ${raw}`
    )
    return failTurn(session, message, mode, detail, true)
  }

  /*
   * No public response or tool call. Private reasoning alone is not a reply;
   * ending silently would leave the user without either an answer or an error.
   */
  if (live && isEmptyTurn(reply, '', streamed.calls.length)) {
    // A supervised CLI executes MCP tools itself, so their calls need not be
    // present in `streamed.calls`. A newly persisted delegation is real work,
    // even when the CLI ends without a prose acknowledgement.
    const hasRecordedAction = listTasks().some((task) => task.sourceSessionId === session.id && task.botId === bot.id && (!existingTasks.has(task.id) || (task.review && !existingReviews.has(task.id))))
    if (hasRecordedAction) {
      message.internal = true
      await commit(session, message)
      return { status: 'final', message, mode }
    }
    const detail =
      `${bot.name} produced no public reply. ` +
      'Send the message again, or try a different model for this bot.'
    return failTurn(session, message, mode, detail, true)
  }

  const read = await readAction(session, reply)
  message.content = read.content
  if (streamed.displayText !== undefined) {
    const final = (await readAction(session, collapseRepeatedLines(streamed.displayText))).content
    message.displayContent = final.trim() ? final : (settings.language === 'zh-CN' ? '本轮已结束，但没有收到最终答复。' : 'The turn ended without a final response.')
  }
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
