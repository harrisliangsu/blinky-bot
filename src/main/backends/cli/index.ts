/**
 * The agent-CLI backend family.
 *
 * Each row wraps a coding agent already installed on this machine. The CLI owns
 * its own tool loop, auth and model routing; OpenBOT supervises it and
 * normalises its output. A CLI compatible with one of these costs a spec row
 * rather than an adapter.
 */

import type { Backend } from '../types'
import { CLAUDE_SPEC, claudeBackend } from './claude'
import { CODEX_SPEC, codexBackend } from './codex'
import { DROID_SPEC, droidBackend } from './droid'
import { GROK_SPEC, grokBackend } from './grok'
import { KIMI_SPEC, kimiBackend } from './kimi'
import { OPENCODE_SPEC, opencodeBackend } from './opencode'
import { PI_SPEC, piBackend } from './pi'
import type { AgentCliSpec } from './spec'

export const AGENT_CLI_SPECS: AgentCliSpec[] = [
  OPENCODE_SPEC,
  CLAUDE_SPEC,
  CODEX_SPEC,
  KIMI_SPEC,
  GROK_SPEC,
  PI_SPEC,
  DROID_SPEC
]

export const agentCliBackends: Backend[] = [
  opencodeBackend,
  claudeBackend,
  codexBackend,
  kimiBackend,
  grokBackend,
  piBackend,
  droidBackend
]

/** Preferred default when nothing is configured yet. */
export const DEFAULT_AGENT_CLI_ID = OPENCODE_SPEC.id

export { stopAgentCliServers } from './serverPool'
export type { AgentCliSpec } from './spec'
