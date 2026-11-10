import type { Settings } from './settings'

export type LocalExecutionPolicy = 'always-allow' | 'ask-every-time' | 'never-allow'

/** The switch governs task access to this Mac, not the application's own storage. */
const LOCAL_TOOLS = new Set([
  'read_file', 'list_dir', 'glob', 'grep', 'write_file', 'edit_file', 'shell', 'watch_folder',
  'screenshot', 'click', 'double_click', 'type_text', 'key_press', 'scroll', 'drag', 'open_app', 'navigate'
])
export const LOCAL_READ_TOOLS = new Set(['read_file', 'list_dir', 'glob', 'grep'])

export function isLocalResourceTool(name: string): boolean { return LOCAL_TOOLS.has(name) }

/** Old restrictions migrate toward asking; old lists and policy remain intact. */
export function localExecutionPolicy(settings?: Pick<Settings, 'localExecutionPolicy' | 'approvalPolicy'>): LocalExecutionPolicy {
  const saved = settings?.localExecutionPolicy
  if (saved === 'always-allow' || saved === 'ask-every-time' || saved === 'never-allow') return saved
  if (saved !== undefined) return 'ask-every-time'
  return settings?.approvalPolicy === 'auto-run' ? 'always-allow' : 'ask-every-time'
}

export const LOCAL_EXECUTION_REFUSAL = '本机执行设为“从不允许”，本次未访问文件或运行任务。 / Local execution is set to Never allow; no local file access or task was performed.'
