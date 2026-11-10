/**
 * The tool registry.
 *
 * `TOOLS` is typed as `Record<ToolId, Tool>`, so the compiler refuses to build
 * if an id in the shared contract has no implementation. Aliases are names a
 * model may reasonably invent (`double_click`) that resolve to a real tool
 * without being advertised in the schema list.
 */

import {
  TOOL_IDS,
  type ComputerTarget,
  type ToolCall,
  type ToolId,
  type ToolResult,
  type ToolSchema
} from '../../shared/types'
import {
  agentTools,
  delegateTaskTool,
  reviewTaskTool,
  manageTaskTool,
  askUserTool,
  scheduleRoutineTool,
  scheduleOnceTool,
  watchFolderTool,
  githubCommentDraftTool,
  watchGitHubIssueTool,
  googleAccountsTool,
  handoffTool,
  rememberTool,
  recallTool,
  requestHelpTool,
  todoWriteTool
} from './agent'
import { computerAliases, computerTools } from './computer/tools'
import {
  editFileTool,
  fsTools,
  globTool,
  grepTool,
  listDirTool,
  readFileTool,
  writeFileTool
} from './fs'
import { clickTool, dragTool, scrollTool } from './computer/pointerTools'
import { keyPressTool, typeTextTool } from './computer/keyboardTools'
import { navigateTool, openAppTool } from './computer/appTools'
import { screenshotTool } from './computer/screenTools'
import { shellTool } from './shell'
import { visualizeTool } from './visualize'
import { fetchTool, webSearchTool, webTools } from './web'
import { listCalendarTool, readGmailTool, searchGmailTool } from './agent/googleRead'
import { gmailDraftTool } from './agent/gmailDraft'
import { calendarDraftTool } from './agent/calendarDraft'
import { watchGmailTool } from './agent/gmailWatch'
import { webhookWatchTool } from './agent/webhookWatch'
import { readXTool, xDraftTool } from './agent/x'
import { slackDraftTool } from './agent/slackDraft'
import type { Tool, ToolContext } from './types'
import { runVmTool, vmTargetSupportsTools } from './computer/vmTools'
import { hasVmComputerCapability } from './computer/vmProtocol'
import { decisionReviewTool } from './agent/decisionReview'
import { reviewToolExecution } from '../agent/decisionReview'
import { getSettings } from '../settings'

/** Every id in the shared contract, implemented. */
const TOOLS: Record<ToolId, Tool> = {
  read_file: readFileTool,
  write_file: writeFileTool,
  edit_file: editFileTool,
  list_dir: listDirTool,
  glob: globTool,
  grep: grepTool,
  shell: shellTool,
  fetch: fetchTool,
  web_search: webSearchTool,
  screenshot: screenshotTool,
  click: clickTool,
  type_text: typeTextTool,
  key_press: keyPressTool,
  scroll: scrollTool,
  drag: dragTool,
  open_app: openAppTool,
  navigate: navigateTool,
  todo_write: todoWriteTool,
  remember: rememberTool,
  recall: recallTool,
  handoff: handoffTool,
  delegate_task: delegateTaskTool,
  review_task: reviewTaskTool,
  decision_review: decisionReviewTool,
  manage_task: manageTaskTool,
  ask_user: askUserTool,
  schedule_routine: scheduleRoutineTool,
  schedule_once: scheduleOnceTool,
  watch_folder: watchFolderTool,
  github_comment_draft: githubCommentDraftTool,
  watch_github_issue: watchGitHubIssueTool,
  search_gmail: searchGmailTool,
  list_google_accounts: googleAccountsTool,
  read_gmail: readGmailTool,
  gmail_draft: gmailDraftTool,
  calendar_event_draft: calendarDraftTool,
  watch_gmail_query: watchGmailTool,
  create_webhook_routine: webhookWatchTool,
  read_x_post: readXTool,
  x_post_draft: xDraftTool,
  slack_message_draft: slackDraftTool,
  list_calendar_events: listCalendarTool,
  request_help: requestHelpTool,
  visualize: visualizeTool
}

const ALIASES = new Map<string, Tool>(computerAliases.map((tool) => [tool.schema.name, tool]))

/**
 * These implementations touch the host filesystem, spawn a host process, or
 * originate network traffic from the host.
 * Until the VM daemon supplies box-native equivalents they must never be
 * advertised or executed for a VM target: degraded functionality is safer
 * than claiming isolation while acting on the user's Mac.
 */
const VM_BOX_TOOLS = new Set<string>([
  'read_file',
  'write_file',
  'edit_file',
  'list_dir',
  'glob',
  'grep',
  'shell',
  'fetch',
  'web_search'
])
const HOST_CONNECTOR_TOOLS = new Set<string>(['github_comment_draft', 'watch_github_issue', 'search_gmail', 'read_gmail', 'gmail_draft', 'list_google_accounts', 'calendar_event_draft', 'watch_gmail_query', 'create_webhook_routine', 'read_x_post', 'x_post_draft', 'slack_message_draft', 'list_calendar_events', 'watch_folder'])

export function isVmBoxTool(name: string): boolean {
  const tool = getTool(name)
  return VM_BOX_TOOLS.has(tool?.schema.name ?? name.trim())
}

/** Groups, for callers that want a themed subset. */
export const toolGroups = {
  filesystem: fsTools,
  shell: [shellTool],
  web: webTools,
  computer: computerTools,
  agent: agentTools
} as const

/** Canonical tools, in `TOOL_IDS` order. */
export function allTools(): Tool[] {
  return TOOL_IDS.map((id) => TOOLS[id])
}

/** Look up by name, accepting aliases. Returns `undefined` for unknown names. */
export function getTool(name: string): Tool | undefined {
  const key = name.trim()
  return TOOLS[key as ToolId] ?? ALIASES.get(key)
}

export function hasTool(name: string): boolean {
  return getTool(name) !== undefined
}

/**
 * Schemas for the ids a bot has enabled, in `TOOL_IDS` order, ignoring unknown
 * ids so a stale bot configuration cannot break a run.
 */
export function schemasFor(enabledIds: string[], target?: ComputerTarget): ToolSchema[] {
  const wanted = new Set(enabledIds.map((id) => id.trim()))
  // Clarification is conversation coordination, not a separately granted effect.
  wanted.add('ask_user')
  if (getSettings().decisionSkillReview === true && target?.kind !== 'vm') wanted.add('decision_review')
  else wanted.delete('decision_review')
  if (wanted.has('remember')) wanted.add('recall')
  if (wanted.has('schedule_routine')) {
    wanted.add('schedule_once')
    if (wanted.has('read_file') || wanted.has('list_dir')) wanted.add('watch_folder')
  }
  if (['search_gmail', 'read_gmail', 'watch_gmail_query', 'gmail_draft', 'list_calendar_events', 'calendar_event_draft'].some(id => wanted.has(id))) wanted.add('list_google_accounts')
  // Reviewing an executor's result is part of delegation. Account access and
  // routine creation are separate capabilities and must be granted explicitly.
  if (wanted.has('delegate_task')) { wanted.add('review_task'); wanted.add('manage_task') }
  return TOOL_IDS.filter(
    (id) =>
      wanted.has(id) &&
      !(
        target?.kind === 'vm' &&
        (HOST_CONNECTOR_TOOLS.has(id) || (VM_BOX_TOOLS.has(id) && !vmTargetSupportsTools(target)) ||
          (TOOLS[id].schema.computerUse === true && !hasVmComputerCapability(target.capabilities)))
      )
  ).map((id) => TOOLS[id].schema)
}

/** Ids that were requested but do not exist — useful for a settings warning. */
export function unknownToolIds(enabledIds: string[]): string[] {
  return enabledIds.filter((id) => !hasTool(id.trim()))
}

export function isComputerTool(name: string): boolean {
  return getTool(name)?.schema.computerUse === true
}

export function isMutatingTool(name: string): boolean {
  return getTool(name)?.schema.mutating === true
}

/**
 * Run one tool call. Never throws: an unknown name, a bad argument or a crash
 * inside a handler all come back as `{ ok: false, output }`.
 */
export async function runTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const started = Date.now()
  const tool = getTool(call.name)
  if (!tool) {
    return {
      callId: call.id,
      name: call.name,
      ok: false,
      output:
        `There is no tool called "${call.name}".\n` +
        `Available tools: ${TOOL_IDS.join(', ')}.`,
      durationMs: Date.now() - started
    }
  }
  if (ctx.computerTarget?.kind === 'vm' && HOST_CONNECTOR_TOOLS.has(tool.schema.name)) return { callId: call.id, name: call.name, ok: false, output: 'This host account connector is unavailable to VM-targeted Bots.', durationMs: Date.now() - started }
  if (
    ctx.computerTarget?.kind === 'vm' &&
    tool.schema.computerUse === true &&
    !hasVmComputerCapability(ctx.computerTarget.capabilities)
  ) {
    return {
      callId: call.id,
      name: call.name,
      ok: false,
      output:
        `${call.name} was refused because VM ${ctx.computerTarget.vmId} has not advertised computer-v1. ` +
        'The action was not redirected to the host screen.',
      durationMs: Date.now() - started
    }
  }
  if (ctx.computerTarget?.kind === 'vm' && VM_BOX_TOOLS.has(tool.schema.name)) {
    if (vmTargetSupportsTools(ctx.computerTarget)) {
      const result = await runVmTool(call, ctx)
      return { ...result, durationMs: result.durationMs ?? Date.now() - started }
    }
    return {
      callId: call.id,
      name: call.name,
      ok: false,
      output:
        `${call.name} was refused because this bot targets VM ${ctx.computerTarget.vmId}, ` +
        `but the installed VM daemon does not provide isolated file, process, and network execution.\n` +
        'Do not retry on the host. Install a box-exec-capable VM daemon or switch this bot to This Mac explicitly.',
      durationMs: Date.now() - started
    }
  }
  const scoped: ToolContext = { ...ctx, callId: call.id }
  const result = await reviewToolExecution(call, scoped, context => tool.handler(call.args ?? {}, context))
  return { ...result, callId: call.id }
}
