/**
 * Tool-consistency helpers for the settings Tools page.
 *
 * The page treats each Bot as an Agent and answers, per tool: who has it
 * enabled, who does not, and whether the fleet is consistent. Syncing is
 * add-only by design — a tool a baseline Agent disabled is never revoked
 * from another Agent automatically.
 */

export interface ToolGroup { id: string; zh: string; en: string; ids: readonly string[] }

export const TOOL_GROUPS: ToolGroup[] = [
  { id: 'dev', zh: '文件与开发', en: 'Files & development', ids: ['read_file', 'write_file', 'edit_file', 'list_dir', 'glob', 'grep', 'shell'] },
  { id: 'web', zh: '网络', en: 'Web', ids: ['fetch', 'web_search'] },
  { id: 'computer', zh: '电脑控制', en: 'Computer control', ids: ['screenshot', 'click', 'type_text', 'key_press', 'scroll', 'drag', 'open_app', 'navigate'] },
  { id: 'present', zh: '展示', en: 'Presentation', ids: ['visualize'] },
  { id: 'agent', zh: 'Agent 与任务', en: 'Agent & tasks', ids: ['todo_write', 'remember', 'recall', 'handoff', 'delegate_task', 'review_task', 'decision_review', 'manage_task', 'ask_user', 'request_help'] },
  { id: 'routines', zh: '例程与触发', en: 'Routines & triggers', ids: ['schedule_routine', 'schedule_once', 'watch_folder', 'watch_github_issue', 'watch_gmail_query', 'create_webhook_routine'] },
  { id: 'connectors', zh: '应用连接器', en: 'App connectors', ids: ['github_comment_draft', 'search_gmail', 'list_google_accounts', 'read_gmail', 'gmail_draft', 'calendar_event_draft', 'read_x_post', 'x_post_draft', 'slack_message_draft', 'list_calendar_events'] }
]

export function groupOfTool(toolId: string): ToolGroup | undefined {
  return TOOL_GROUPS.find((group) => group.ids.includes(toolId))
}

export type AgentToolState = 'on' | 'off'

export interface AgentToolCell { botId: string; name: string; state: AgentToolState }

/** Consistency across the fleet: every Agent on → consistent, otherwise how many are off. */
export function toolConsistency(cells: AgentToolCell[]): { consistent: boolean; off: number } {
  const off = cells.filter((cell) => cell.state === 'off').length
  return { consistent: off === 0, off }
}

/**
 * Add-only sync plan: every Agent that lacks the tool and is not the baseline
 * gets it added. Baseline and already-enabled Agents are untouched, and the
 * baseline's disabled tools are never removed from anyone.
 */
export function toolSyncPlan(cells: AgentToolCell[], baselineId: string, toolId: string, baselineTools: string[]): Array<{ botId: string; add: string[] }> {
  const plan: Array<{ botId: string; add: string[] }> = []
  const desired = new Set(baselineTools)
  for (const cell of cells) {
    if (cell.botId === baselineId) continue
    const add: string[] = []
    if (desired.has(toolId) && cell.state === 'off') add.push(toolId)
    if (add.length) plan.push({ botId: cell.botId, add })
  }
  return plan
}
