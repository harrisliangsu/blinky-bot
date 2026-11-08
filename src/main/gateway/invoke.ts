/**
 * One `tools/call`, from the CLI's loop into OpenBOT's.
 *
 *   grant scope → mode → denylist → computer-use permission → approval → registry → content
 *
 * The CLI decides *when* to call a tool; it never decides whether it may. Every
 * mutating or computer-use call goes through `agent/approval.requestApproval`
 * before a handler runs, exactly as the in-app loop does, and a refusal comes
 * back as an MCP error result rather than an exception.
 *
 * Computer-use asks carry a preview frame captured from the bot's own computer
 * target, so the user approves against a picture of the screen. The frame is
 * taken through the tool layer's cache, so the handler's own gate reuses it and
 * asks nothing further — one action, one prompt.
 */

import { randomUUID } from 'node:crypto'
import type { ToolCall, ToolResult } from '../../shared/types'
import { requestApproval } from '../agent/approval'
import {
  deniedRuleForCall,
  denyRefusal,
  detailFor,
  kindForTool,
  rememberKey,
  summarise,
  targetForCall
} from '../agent/approvalPolicy'
import { broadcast } from '../agent/events'
import { allowedInMode, isMutatingTool, modeRefusal } from '../agent/modes'
import { settingsStore } from '../agent/settingsGateway'
import { SELF_APPROVING } from '../agent/toolContext'
import { getComputerProvider } from '../tools/computer'
import { dataRoot } from '../store/paths'
import { captureFrame } from '../tools/computer/gate'
import { runTool } from '../tools/registry'
import type { ToolContext } from '../tools/types'
import { type McpToolCallResult, refusal, toCallResult } from './content'
import { describeTools, exposedSchema, sessionMode } from './descriptors'
import { gatewayHost } from './host'
import type { Grant } from './tokens'
import { getBot } from '../store/bots'
import { getSession } from '../store/sessions'
import { bindExecutionAgent, isCodexCoordinator } from '../agent/executionAgent'
import { isLocalResourceTool } from '../../shared/localExecution'
import { getSettings } from '../settings'
import { taskJudgmentAllows, taskJudgmentScope } from '../agent/taskJudgmentScope'

const WORKER_TOOLS = new Set(['shell', 'fetch', 'web_search', 'screenshot', 'click', 'double_click', 'type_text', 'key_press', 'scroll', 'drag', 'open_app', 'navigate'])

export async function invokeTool(
  grant: Grant,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<McpToolCallResult> {
  const judgment=taskJudgmentScope(grant.sessionId)
  if(judgment&&!taskJudgmentAllows(grant.sessionId,name,args)){judgment.attemptedTool=true;return refusal('Internal task consideration permits only scoped task inspection, not task mutation, delegation, file access or execution. Return a decision; the host validates and delivers it.')}
  const mode = sessionMode(grant.sessionId)
  const schema = exposedSchema(grant.tools, name, grant.computerTarget)
  if (!schema) {
    const available = describeTools(grant.tools, grant.computerTarget, mode).map((t) => t.name)
    return refusal(
      `"${name}" is not available to this bot. Enabled tools: ${available.join(', ') || 'none'}.`
    )
  }

  const session = getSession(grant.sessionId)
  const bot = getBot(grant.botId)
  if (!session || !bot || bot.archived || !session.botIds.includes(grant.botId)) return refusal('The Bot or execution conversation is no longer available.')
  const currentBot = bindExecutionAgent(grant.sessionId, bot)
  if (!exposedSchema(currentBot.tools, name, currentBot.computerTarget)) return refusal('This tool permission was withdrawn. Start a new turn after the user updates app access.')
  if (session && bot && isCodexCoordinator(session, bot) && (schema.computerUse || WORKER_TOOLS.has(schema.name))) {
    return refusal(`Use delegate_task for ${schema.name}; the independent execution agent can perform this work with the configured permissions.`)
  }

  /*
   * The same refusal `execute.ts` gives our own loop. Withholding the tool from
   * `tools/list` is not enough on its own: a CLI caches the list from before the
   * user switched mode, and its model calls tools it merely remembers. Nothing
   * else on this path re-checks the mode — it goes straight to `runTool`, so
   * every mutation an agent-CLI bot made in Ask or Plan mode came through here.
   */
  if (!allowedInMode(mode, schema.name, schema, args)) {
    return refusal(modeRefusal(mode, schema.name))
  }

  if (schema.computerUse && !grant.computerUse) {
    return refusal(
      `Refused: "${schema.name}" needs screen capture and input control, which this bot has not ` +
        'been granted. The user can enable computer use for it in its settings.'
    )
  }

  const call: ToolCall = { id: randomUUID(), name: schema.name, args }
  if (signal.aborted) return refusal('Stopped before this tool ran.')

  /*
   * The whole call against the denylist, exactly as `execute.ts` does it for our
   * own loop: the approval gate below only ever sees the single derived target,
   * and a self-approving tool does not reach it here at all.
   */
  const denied = deniedRuleForCall(await settingsStore.get(), call)
  if (denied) return refusal(denyRefusal(call.name, denied))

  publish(grant, { type: 'tool-call', call })

  const granted = new Set<string>()
  const target = targetForCall(call)

  // A self-approving tool must build its own card. In particular, computer use
  // attaches a live preview and high-risk shell calls mark the request `force`.
  // Pre-approving those here used to cache a weaker, generic answer which then
  // satisfied the handler's mandatory confirmation.
  const selfApproving = SELF_APPROVING.has(call.name) || (call.name === 'manage_task' && args.action === 'resume')
  if (!selfApproving && (isMutatingTool(call.name, schema, args) || schema.computerUse)) {
    const outcome = await requestApproval({
      sessionId: grant.sessionId,
      botId: grant.botId,
      toolName: call.name,
      call,
      target,
      localExecution: grant.computerTarget?.kind !== 'vm' && isLocalResourceTool(call.name),
      kind: kindForTool(call.name, schema),
      summary: summarise(call.name, call, target),
      detail: detailFor(call),
      preview: schema.computerUse ? await previewFrame(grant, signal) : undefined,
      // Screen control is always confirmed, whatever the policy says — otherwise
      // `auto-run` answers this card itself and the user's screen is driven with
      // no prompt. The tools that ask for themselves already mark it `force`.
      force: schema.computerUse === true,
      signal
    })
    if (!outcome.approved) {
      const result = failed(call, `Not approved — ${outcome.reason}. Do not retry this unchanged.`)
      publish(grant, { type: 'tool-result', result })
      return toCallResult(result)
    }
    granted.add(rememberKey(call.name, target))
  }

  const refreshed = getBot(grant.botId)
  if (signal.aborted || grant.abort.signal.aborted || !refreshed || !exposedSchema(bindExecutionAgent(grant.sessionId, refreshed).tools, name, refreshed.computerTarget)) return refusal('Tool access was withdrawn before execution.')
  const result = await runTool(call, await buildContext(grant, call, signal, granted))
  publish(grant, { type: 'tool-result', result })
  if (result.screenshot) {
    broadcast({ type: 'computer-frame', sessionId: grant.sessionId, screenshot: result.screenshot })
  }
  return toCallResult(result)
}

async function buildContext(
  grant: Grant,
  call: ToolCall,
  signal: AbortSignal,
  granted: Set<string>
): Promise<ToolContext> {
  return {
    backendId: (() => { const bot = getBot(grant.botId); return bot ? bindExecutionAgent(grant.sessionId, bot).backendId : undefined })(),
    sessionId: grant.sessionId,
    botId: grant.botId,
    cwd: grant.cwd,
    dataDir: dataRoot(),
    signal,
    clarificationScope: grant.abort.signal,
    computerTarget: grant.computerTarget,
    callId: call.id,
    messageId: grant.messageId,
    settings: await settingsStore.get(),
    getSettings,
    host: gatewayHost,
    emit: (event) => broadcast(event),
    requestApproval: async (req) => {
      const target = targetForCall(call)
      // A normal grant can only satisfy another normal request. `force` means
      // the handler has declared this particular action destructive or outside
      // the workspace, so it must always reach the policy gate itself.
      if (!req.force && granted.has(rememberKey(req.toolName, target))) return true
      const outcome = await requestApproval({
        sessionId: grant.sessionId,
        botId: grant.botId,
        toolName: req.toolName,
        call,
        target,
        localExecution: grant.computerTarget?.kind !== 'vm' && isLocalResourceTool(call.name),
        kind: req.kind,
        summary: req.summary,
        detail: req.detail,
        preview: req.preview,
        force: req.force === true,
        requestId: req.id,
        signal
      })
      if (outcome.approved && !req.force) granted.add(rememberKey(req.toolName, target))
      return outcome.approved
    }
  }
}

/** Best effort: a target that cannot be captured still gets its approval prompt. */
async function previewFrame(grant: Grant, signal: AbortSignal): Promise<string | undefined> {
  try {
    const frame = await captureFrame(
      getComputerProvider(grant.computerTarget, { botId: grant.botId, sessionId: grant.sessionId, dataDir: dataRoot() }),
      signal
    )
    return frame.image
  } catch {
    return undefined
  }
}

type ToolEvent = { type: 'tool-call'; call: ToolCall } | { type: 'tool-result'; result: ToolResult }

/** Mirror the CLI's tool activity into the transcript, when a message owns it. */
function publish(grant: Grant, event: ToolEvent): void {
  const messageId = grant.messageId
  if (!messageId) return
  broadcast({ ...event, sessionId: grant.sessionId, messageId })
}

function failed(call: ToolCall, output: string): ToolResult {
  return { callId: call.id, name: call.name, ok: false, output }
}
