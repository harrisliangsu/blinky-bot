/**
 * Barrel for the shared contract.
 *
 * The contract lives in focused modules alongside this file; import from here
 * when you want several of them, or from the specific module when you want one.
 *
 *   chat.ts      messages, tool calls, attachments
 *   bots.ts      bot personas and memory
 *   computer.ts  where a bot's GUI interaction happens (host vs. VM)
 *   routines.ts  record & replay
 *   sessions.ts  sessions and exchanges
 *   backends.ts  model backends (local and cloud are peers)
 *   settings.ts  user settings
 *   tools.ts     tool schemas and the approval vocabulary
 *   events.ts    the canonical main -> renderer event union
 *   api.ts       the IPC surface on window.openbot
 */

export type * from './chat'
export type * from './bots'
export type * from './computer'
export type * from './routines'
export type * from './sessions'
export type * from './projects'
export type * from './backends'
export type * from './settings'
export type * from './updates'
export type * from './skills'
export type * from './visualization'
export type * from './events'
export type * from './search'
export type * from './activity'
export type * from './rooms'
export type * from './cards'
export type * from './api'

// Value export: the default column set is read at runtime.
export { DEFAULT_COLUMNS } from './projects'

// Skill helpers are called at runtime, so they are value exports.
export {
  SHARED_SKILL_ORIGIN,
  SKILL_FILE,
  SKILL_ORIGINS,
  SKILL_ORIGIN_LABELS,
  dedupeByPreference,
  isSkillName,
  parseSkillId,
  preferenceFor,
  skillId
} from './skills'

// Value export (not type-only): the tool id list is iterated at runtime.
export { TOOL_IDS } from './tools'
export type { ToolId, ToolSchema, ApprovalRequest, ApprovalDecision } from './tools'
