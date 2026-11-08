/**
 * Agent modes.
 *
 * `agent` — full tool use.
 * `ask`   — read-only: inspect and explain, never mutate.
 * `plan`  — read-only, and the turn must end in a written plan awaiting confirmation.
 *
 * Modes are enforced twice: mutating tools are withheld from the model's tool list, and
 * refused again at execution time in case the model calls one anyway.
 */

import type { AgentMode, ToolSchema } from '../../shared/types'

/** Tools that only observe. Anything unknown is treated as mutating. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'list_dir',
  'glob',
  'grep',
  'fetch',
  'web_search',
  'screenshot'
])

/** Coordination tools that touch no user state, so every mode may use them. */
export const ALWAYS_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'handoff',
  'todo_write',
  'remember'
])

/**
 * A tool's own declaration wins. `ALWAYS_ALLOWED_TOOLS` used to be checked first, which
 * silently overrode it: `remember` declares `mutating: true` truthfully and was read as
 * read-only anyway, so the executor never gated it. Nothing was exposed — `remember`
 * raises its own approval — but the precedence would have un-gated any future tool put in
 * that set. Membership of the set is about which *modes* may call a tool, and that is
 * decided in `allowedInMode`, not here.
 */
export function isMutatingTool(name: string, schema?: ToolSchema, args?: Record<string, unknown>): boolean {
  // The aggregate schema keeps inspection discoverable. At execution time,
  // classify the actual action; unknown actions must not inherit read access.
  if (name === 'manage_task' && args !== undefined) return !['list', 'inspect', 'match'].includes(String(args.action))
  if (schema && typeof schema.mutating === 'boolean') return schema.mutating
  if (ALWAYS_ALLOWED_TOOLS.has(name)) return false
  return !READ_ONLY_TOOLS.has(name)
}

/**
 * Does this mode forbid changing anything?
 *
 * Asked by the parts of the app that cannot filter a tool list — a supervised turn hands
 * the whole loop to an agent CLI, and all those adapters understand is "read-only".
 */
export function isReadOnlyMode(mode: AgentMode): boolean {
  return mode === 'ask' || mode === 'plan'
}

export function allowedInMode(mode: AgentMode, name: string, schema?: ToolSchema, args?: Record<string, unknown>): boolean {
  if (mode === 'agent') return true
  // Coordination tools touch no user state, so a read-only mode may still use them.
  if (ALWAYS_ALLOWED_TOOLS.has(name)) return true
  return !isMutatingTool(name, schema, args)
}

export function filterToolsForMode(schemas: ToolSchema[], mode: AgentMode): ToolSchema[] {
  if (mode === 'agent') return schemas
  return schemas.filter((s) => allowedInMode(mode, s.name, s))
}

export function modeRefusal(mode: AgentMode, name: string): string {
  return mode === 'plan'
    ? `Refused: "${name}" modifies state, and this session is in Plan mode. Finish the ` +
        `plan and ask the user to confirm; they can switch to Agent mode to run it.`
    : `Refused: "${name}" modifies state, and this session is in Ask mode, which is ` +
        `read-only. Describe what you would do instead.`
}

const AGENT_RULES = [
  'MODE: AGENT — full tool use.',
  'Use tools to gather your own context instead of asking the user for things you can look up.',
  'Follow the user-configured approval rules. If an action is rejected or denied by policy, do not retry it verbatim: adapt, or ask ' +
    'the user what they want instead.',
  'Prefer small verified steps over one large speculative change, and state what you did.'
].join('\n')

const ASK_RULES = [
  'MODE: ASK — read-only.',
  'You may read files, search, and fetch, but you must not modify anything: no writes, no ' +
    'edits, no shell side effects, no input injection. Mutating tools are withheld.',
  'When the user asks for a change, explain precisely what you would do — which files, ' +
    'which commands — and tell them to switch to Agent mode to carry it out.'
].join('\n')

const PLAN_RULES = [
  'MODE: PLAN — investigate and plan, change nothing.',
  'Use read-only tools to ground the plan in what is actually there. Mutating tools are ' +
    'withheld and will be refused.',
  'Finish the turn with a written plan: numbered steps, the files each step touches, the ' +
    'commands to run, and the risks or open questions.',
  'End by asking the user to confirm the plan. Do not begin implementing it in this mode.'
].join('\n')

export function modeRules(mode: AgentMode): string {
  if (mode === 'ask') return ASK_RULES
  if (mode === 'plan') return PLAN_RULES
  return AGENT_RULES
}
