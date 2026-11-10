/**
 * Codex app-server notification → `ChatChunk`, and approval request → answer.
 *
 * Method names and payload shapes come from the CLI's own schema, emitted by
 * `codex app-server generate-json-schema --out <dir>` (checked against Codex
 * 0.166). Unknown notifications are ignored: the server emits dozens we have
 * no use for (rate limits, fs watches, realtime audio, hooks, account
 * updates, MCP startup). A payload that happens to contain an `error` field
 * is still not a turn failure — only the `error` method, and a
 * `turn/completed` whose status is `failed`, end the turn.
 */

import { isPlainObject } from '../lenientJson'
import type { ChatChunk } from '../types'
import { str, type CodexItems } from './codexItems'
import { agentTraceEntry } from './agentTrace'
import { redactSecrets } from '../vaultRedaction'

/*
 * The two approval halves live in `codexApprovals.ts` and the notification
 * index in `codexItems.ts`; both are re-exported here because this module is
 * the one `codexAppServer.ts` talks to, and a single import site keeps the
 * transport unaware of how the mapping is arranged.
 */
export { CodexItems } from './codexItems'
export { approvalResponse, describeApproval } from './codexApprovals'

/** `delta` sits at the top level on some notifications and under `item` on others. */
function deltaOf(params: unknown): string {
  if (!isPlainObject(params)) return ''
  const direct = str(params.delta) || str(params.text)
  if (direct) return direct
  const item = isPlainObject(params.item) ? params.item : null
  return item ? str(item.delta) || str(item.text) : ''
}

/** A notice the user can see that must not end the turn. */
function activity(text: string, category: 'reconnect' | 'transport' | 'warning' = 'warning'): ChatChunk[] {
  const line = text.trim()
  return line ? [{ type: 'notice', category, message: line }] : []
}

/**
 * Readable text of a Codex `TurnError`.
 *
 * On the v2 `error` notification the message is `params.error.message` — an
 * object, so `str(params.error)` is empty and the old mapper reported the
 * generic "codex reported an error" for a reconnect that was about to
 * succeed. `additionalDetails` is the part that says why ("Connection reset
 * by peer"). Older builds put a string at `params.message` or `params.error`.
 */
function codexTurnErrorText(params: unknown): string {
  if (!isPlainObject(params)) return ''
  const nested = isPlainObject(params.error) ? params.error : null
  const misalignment = nested && isPlainObject(nested.misalignment) ? nested.misalignment : null
  const parts = [
    (nested && str(nested.message)) || str(params.message) || str(params.error),
    (nested && str(nested.additionalDetails)) || str(params.additionalDetails),
    misalignment ? str(misalignment.detailedExplanation) : ''
  ]
  const unique: string[] = []
  for (const part of parts) {
    const text = part.trim()
    if (!text) continue
    if (unique.some((kept) => kept.includes(text))) continue
    unique.push(text)
  }
  return unique.join('\n')
}

function isRetryableError(params: unknown): boolean {
  return isPlainObject(params) && params.willRetry === true
}

/** Assistant text on one item, or on the `items` array a finished turn repeats. */
function agentText(value: unknown, items?: CodexItems): ChatChunk[] {
  const records = Array.isArray(value) ? value : [value]
  const out: ChatChunk[] = []
  for (const raw of records) {
    if (!isPlainObject(raw)) continue
    const text = items
      ? items.consumeAgentText(raw)
      : raw.type === 'agentMessage'
        ? str(raw.text)
        : ''
    if (text) {
      const id = str(raw.id)
      const phase = items?.agentPhase(id)
      out.push({ type: 'text', delta: `${items?.agentTextPrefix(id) ?? ''}${text}`, visible: true, ...(phase ? { segment: { id, phase, delta: text } } : {}) })
    }
  }
  return out
}

/**
 * A failure Codex reported for this turn: the model call failed, or the
 * server said the turn finished as `failed`. Transport failures (the
 * app-server never started, the pipe closed) stay ordinary `Error`s so the
 * runner can still explain that it will not fall back to an ungoverned exec.
 */
export class CodexTurnError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexTurnError'
  }
}

/**
 * What the chat should show when the app-server run throws.
 *
 * A turn Codex itself rejected keeps Codex's message. Anything else means the
 * governed server was not available, and BlinkyBot still refuses the one-shot
 * exec fallback that would drop approval prompts.
 */
export function presentCodexError(err: unknown): Error {
  if (err instanceof CodexTurnError) return err
  const reason = err instanceof Error ? err.message : String(err)
  return new Error(
    `Codex's governed app-server was unavailable, so BlinkyBot refused to fall back to an ` +
      `ungoverned one-shot run. ${reason}`,
    { cause: err }
  )
}

export function codexNotification(
  method: string,
  params: unknown,
  items?: CodexItems,
  captureAgentTrace = false
): ChatChunk[] {
  // Before the switch, so the notifications this file has no chunk for are
  // still not thrown away — they are what makes an approval card readable.
  items?.observe(method, params)

  switch (method) {
    case 'item/autoApprovalReview/completed': {
      const root = isPlainObject(params) ? params : {}, review = isPlainObject(root.review) ? root.review : {}, action = isPlainObject(root.action) ? root.action : {}
      const status = str(review.status)
      if (status !== 'denied' && status !== 'timedOut' && status !== 'aborted') return []
      const kind = str(action.type) || 'operation'
      const target = str(action.command) || str(action.program) || str(action.toolName) || str(action.host) || (Array.isArray(action.files) ? action.files.filter((v): v is string => typeof v === 'string').join(', ') : '')
      const safeAction = redactSecrets(`${kind}${target ? `: ${target}` : ''}`).slice(0, 400)
      const reason = redactSecrets(str(review.rationale)).slice(0, 800).trim()
      const summary = status === 'denied' ? 'Codex 自动审批复审拒绝了此操作' : status === 'timedOut' ? 'Codex 自动审批复审超时' : 'Codex 自动审批复审被中止'
      throw new CodexTurnError(`${summary}：${safeAction}。${reason ? `原因：${reason}。` : '复审未提供原因。'}本轮已停止，请先检查已发生的操作。`)
    }
    case 'item/agentMessage/delta': {
      const delta = deltaOf(params)
      const id = isPlainObject(params) ? str(params.itemId) : ''
      const phase = items?.agentPhase(id)
      // agentMessage is public assistant speech even when older servers omit
      // phase. Reasoning, plans and tool events have separate method families.
      return delta ? [{ type: 'text', delta: `${items?.agentTextPrefix(id) ?? ''}${delta}`, visible: true, ...(phase ? { segment: { id, phase, delta } } : {}) }] : []
    }

    case 'item/reasoning/textDelta':
    case 'item/reasoning/summaryTextDelta':
    case 'item/plan/delta': {
      const delta = deltaOf(params)
      return delta ? [{ type: 'reasoning', delta }] : []
    }

    case 'thread/tokenUsage/updated': {
      const p = isPlainObject(params) ? params : {}
      const usage = isPlainObject(p.tokenUsage) ? p.tokenUsage : null
      // `total` is context held; `last` is just the most recent request.
      const total = usage && isPlainObject(usage.total) ? usage.total : null
      if (!total) return []
      const num = (raw: unknown): number | undefined =>
        typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
      return [
        {
          type: 'usage',
          usage: {
            inputTokens: num(total.inputTokens),
            outputTokens: num(total.outputTokens),
            totalTokens: num(total.totalTokens),
            cachedInputTokens: num(total.cachedInputTokens)
          }
        }
      ]
    }

    case 'item/started':
    case 'item/completed': {
      if (captureAgentTrace && isPlainObject(params) && isPlainObject(params.item)) {
        const item = params.item
        const kind = str(item.type)
        if (['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch'].includes(kind)) {
          return [{ type: 'agent_trace', entry: agentTraceEntry(str(item.id), kind, method === 'item/started' ? 'started' : 'completed', item) }]
        }
      }
      /*
       * `item/completed` repeats the finished item after any deltas. Only an
       * agentMessage is part of the reply, and only the part deltas did not
       * already stream. Every other ThreadItem Codex 0.166 sends
       * (commandExecution, fileChange, mcpToolCall, reasoning, plan,
       * webSearch, and the rest) is either an approval recorded above or
       * ignored. An unrecognised type takes the same path. `item/started`
       * carries the same shape before the text exists, so it stays quiet.
       */
      if (method !== 'item/completed' || !isPlainObject(params)) return []
      return agentText(params.item, items)
    }

    case 'warning':
    case 'guardianWarning': {
      const message = isPlainObject(params) ? str(params.message) : ''
      if (method === 'guardianWarning' && message.startsWith('Automatic approval review approved (')) {
        return []
      }
      return activity(message, /falling back from websockets to https/i.test(message) ? 'transport' : 'warning')
    }

    case 'error': {
      /*
       * Stream disconnects arrive as `error` with `willRetry: true`
       * ("Reconnecting... 2/5") and the turn still completes. Treating every
       * `error` as fatal aborted those turns. `willRetry: false` is terminal.
       */
      const text = codexTurnErrorText(params)
      if (isRetryableError(params)) return activity(text, 'reconnect')
      throw new CodexTurnError(text || 'codex reported an error')
    }

    case 'turn/completed': {
      const root = isPlainObject(params) ? params : {}
      const turn = isPlainObject(root.turn) ? root.turn : root
      if (str(turn.status) === 'failed') {
        const text = codexTurnErrorText({ error: turn.error })
        throw new CodexTurnError(text || 'codex turn failed')
      }
      return agentText(turn.items, items)
    }

    default:
      /*
       * Known Codex 0.166 families that must not abort a turn, even when the
       * payload has an `error` string or the method contains "error":
       * `hook/*`, `account/*` (including `account/login/completed`),
       * `mcpServer/*` (including `mcpServer/startupStatus/updated`),
       * `thread/realtime/error`, `configWarning`, `deprecationNotice`.
       * Anything this client does not recognise is ignored the same way.
       */
      return []
  }
}

/** True once the server says this turn is finished. */
export function isTurnEnd(method: string): boolean {
  return method === 'turn/completed'
}
