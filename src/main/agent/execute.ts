/**
 * Tool-call execution: every gate a call must pass, and the fan-out of its result.
 *
 *   mode gate → denylist → computer-use permission → approval gate → handler → result events
 *
 * Nothing here throws. A missing tool, a rejected approval or a handler that blows up all
 * come back as a failed `ToolResult`, which the loop feeds to the model so it can adapt.
 */

import type { Bot, Session, Settings, ToolCall, ToolResult, ToolSchema } from '../../shared/types'
import { liveBotTools } from './botToolScope'
import { requestApproval } from './approval'
import {
  deniedRuleForCall,
  denyRefusal,
  detailFor,
  kindForTool,
  summarise,
  targetForCall
} from './approvalPolicy'
import { builtinSchema, mergeBuiltins } from './builtins'
import { applyTodos, normaliseTodos, runRemember, runTodoWrite } from './builtinHandlers'
import { broadcast } from './events'
import { errorMessage, isAbortError } from './errors'
import { allowedInMode, isMutatingTool, modeRefusal } from './modes'
import { captureToolStep, noteFrame } from './recorder'
import { buildToolContext, SELF_APPROVING } from './toolContext'
import { getTool, schemasFor } from './toolGateway'
import { now } from './ids'
import type { ToolEntry } from './contracts'
import { startAppleVm } from '../vm/appleVmSupervisor'
import { vmToken } from '../store/vmSecrets'
import { settingsStore } from './settingsGateway'
import { isLocalResourceTool } from '../../shared/localExecution'
import { taskJudgmentAllows, taskJudgmentScope } from './taskJudgmentScope'

export interface ExecuteInput {
  session: Session
  bot: Bot
  settings: Settings
  call: ToolCall
  /** Assistant message the call belongs to — the `tool-result` event is keyed to it. */
  messageId: string
  signal: AbortSignal
  /** The assistant's own words before the call, kept as the routine step intent. */
  intent?: string
  /** False while replaying a routine, so a replay does not re-record itself. */
  record?: boolean
}

/** Enforce the same effective tool grant used to advertise schemas to the model.
 * Registry aliases must resolve to the capability they implement, not acquire an
 * independent grant. Built-ins continue working when the optional registry is
 * unavailable, but only when the Bot explicitly enabled them. */
export async function toolAllowedForBot(bot: Bot, name: string, resolved?: ToolEntry | null): Promise<boolean> {
  const entry = resolved === undefined ? await getTool(name) : resolved
  const schema = entry?.schema ?? builtinSchema(name)
  if (!schema) return false
  const canonical = schema.name === 'double_click' ? 'click' : schema.name
  const enabled = liveBotTools(bot.id, bot.tools ?? [])
  const exposed = mergeBuiltins(await schemasFor(enabled, bot.computerTarget), enabled)
  return exposed.some((item) => item.name === canonical)
}

export async function executeCall(input: ExecuteInput): Promise<ToolResult> {
  const judgment=taskJudgmentScope(input.session.id)
  if(judgment&&!taskJudgmentAllows(input.session.id,input.call.name,input.call.args??{})){judgment.attemptedTool=true;return {callId:input.call.id,name:input.call.name,ok:false,output:'Internal task consideration permits only scoped task inspection, not task mutation, delegation, file access or execution. Return a decision; the host validates and delivers it.'}}
  input = { ...input, settings: await settingsStore.get() }
  const { session, bot, call, signal } = input
  const startedAt = now()

  const entry = await getTool(call.name)
  const schema = entry?.schema ?? builtinSchema(call.name)

  const permitted = await toolAllowedForBot(bot, call.name, entry)
  const refusal = gate(input, schema, entry !== null, permitted)
  const result = refusal ?? (await approveAndRun(input, schema, entry))

  const finished: ToolResult = {
    ...result,
    callId: call.id,
    name: call.name,
    durationMs: result.durationMs ?? now() - startedAt
  }

  if (finished.screenshot) {
    noteFrame(finished.screenshot)
    broadcast({ type: 'computer-frame', sessionId: session.id, screenshot: finished.screenshot })
  }
  broadcast({
    type: 'tool-result',
    sessionId: session.id,
    messageId: input.messageId,
    result: finished
  })

  if (input.record !== false && !signal.aborted) {
    captureToolStep({ botId: bot.id, call, result: finished, intent: input.intent })
  }
  return finished
}

/** Checks that need no user interaction. Returns a failed result, or null to proceed. */
function gate(
  input: ExecuteInput,
  schema: ToolSchema | undefined,
  known: boolean,
  permitted: boolean
): ToolResult | null {
  const { call, session, bot, signal } = input

  if (signal.aborted) return fail(call, 'Stopped before this tool ran.')

  if (call.name === 'handoff') {
    return fail(call, 'Handoff is handled by the session itself and cannot be run as a tool here.')
  }

  if (!known && !builtinSchema(call.name)) {
    return fail(call, `Unknown tool "${call.name}". Use one of the tools listed in your instructions.`)
  }

  if (!permitted) return fail(call, `Refused: "${call.name}" is not enabled for this bot.`)

  if (!allowedInMode(session.mode, call.name, schema, call.args ?? {})) {
    return fail(call, modeRefusal(session.mode, call.name))
  }

  /*
   * The whole call against the denylist, before any of it runs. The approval gate
   * checks the denylist too, but only against the one target it derives — so a
   * tool carrying its payload in `script` or `body` was never checked at all, and
   * a tool that raises its own approval, or none, never reached that check.
   */
  const denied = deniedRuleForCall(input.settings, call)
  if (denied) return fail(call, denyRefusal(call.name, denied))

  if (schema?.computerUse && !bot.computerUse) {
    return fail(
      call,
      `Refused: "${call.name}" needs screen capture and input control, which this bot has ` +
        `not been granted. The user can enable computer use for it in its settings.`
    )
  }

  return null
}

async function approveAndRun(
  input: ExecuteInput,
  schema: ToolSchema | undefined,
  entry: ToolEntry | null
): Promise<ToolResult> {
  const { call, session, signal } = input

  // Tools that describe their own action ask for themselves; see `toolContext.ts`.
  const selfApproving = SELF_APPROVING.has(call.name) || (call.name === 'manage_task' && call.args?.action === 'resume')
  const needsApproval =
    !selfApproving && (isMutatingTool(call.name, schema, call.args ?? {}) || schema?.computerUse === true)

  if (needsApproval) {
    const target = targetForCall(call)
    const outcome = await requestApproval({
      sessionId: session.id,
      botId: input.bot.id,
      toolName: call.name,
      call,
      target,
      localExecution: input.bot.computerTarget?.kind !== 'vm' && isLocalResourceTool(call.name),
      kind: kindForTool(call.name, schema),
      summary: summarise(call.name, call, target),
      detail: detailFor(call),
      /*
       * Screen control is always confirmed, whatever the policy says — the same
       * rule `tools/computer/gate.ts` applies to the tools that ask for
       * themselves. Without it a computer-use tool outside `SELF_APPROVING`
       * would raise an ordinary request, and `auto-run` would answer it: the
       * user's screen driven with no prompt at all. Latent only because that set
       * happens to hold every computer tool today.
       */
      force: schema?.computerUse === true,
      signal
    })
    if (!outcome.approved) {
      return fail(call, `Not approved — ${outcome.reason}. Do not retry this unchanged.`)
    }
  }

  try {
    if (entry) {
      if (input.bot.computerTarget?.kind === 'vm' && input.bot.computerTarget.managed === 'apple-vm') {
        // Managed bridges belong to the Electron process, so reopening the app
        // must restore one before any guest-bound tool can make its request.
        await startAppleVm(input.bot.computerTarget, signal, vmToken(input.bot.id))
      }
      const ctx = buildToolContext({
        session,
        bot: input.bot,
        settings: input.settings,
        call,
        messageId: input.messageId,
        signal,
        preApproved: needsApproval
      })
      const result = shape(call, await entry.handler(call.args ?? {}, ctx))
      if (call.name === 'todo_write' && result.ok) await syncTodos(input, result)
      return result
    }
    return await runBuiltin(input)
  } catch (err) {
    if (isAbortError(err) || signal.aborted) {
      return fail(call, 'Stopped while this tool was running.')
    }
    return fail(call, `${call.name} failed: ${errorMessage(err)}`)
  }
}

async function runBuiltin(input: ExecuteInput): Promise<ToolResult> {
  const { call, session, bot } = input
  if (call.name === 'todo_write') return runTodoWrite(session, call)
  if (call.name === 'remember') return runRemember(bot.id, call)
  return fail(call, `Tool "${call.name}" has no handler available in this build.`)
}

/** Keep the session's todo list in step with a registry-provided `todo_write`. */
async function syncTodos(input: ExecuteInput, result: ToolResult): Promise<void> {
  const todos = normaliseTodos(result.detail ?? input.call.args?.['todos'])
  if (todos.length > 0) await applyTodos(input.session, todos)
}

/** Coerce whatever a handler returned into a well-formed `ToolResult`. */
function shape(call: ToolCall, raw: unknown): ToolResult {
  if (raw && typeof raw === 'object') {
    const rec = raw as Partial<ToolResult>
    return {
      callId: call.id,
      name: call.name,
      ok: rec.ok !== false,
      output: typeof rec.output === 'string' ? rec.output : stringifyOutput(rec.output),
      detail: rec.detail,
      screenshot: typeof rec.screenshot === 'string' ? rec.screenshot : undefined,
      durationMs: typeof rec.durationMs === 'number' ? rec.durationMs : undefined
    }
  }
  return { callId: call.id, name: call.name, ok: true, output: stringifyOutput(raw) }
}

function stringifyOutput(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return '(no output)'
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function fail(call: ToolCall, output: string): ToolResult {
  return { callId: call.id, name: call.name, ok: false, output }
}
