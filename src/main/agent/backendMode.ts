/**
 * Which loop runs a turn.
 *
 * `orchestrated` — model APIs and pi in model-only mode. We own the loop:
 *                  stream → execute tool calls → append results → iterate, under the
 *                  iteration cap.
 *
 * `supervised`   — agent CLIs. The CLI owns its own loop and executes its own tools;
 *                  its adapter renders that activity as text rather than as `tool_call`
 *                  chunks, precisely so nothing is executed twice. We forward the turn,
 *                  re-broadcast what comes back, and bound it by how long it goes quiet
 *                  for rather than by iterations. Our distinctive tools reach that loop
 *                  through the MCP gateway, which calls back into `sessionActions`.
 */

import type { BackendInfo, ComputerTarget } from '../../shared/types'
import { usesApplicationToolLoop } from '../../shared/executionAgentCapabilities'

export type TurnMode = 'orchestrated' | 'supervised'

/**
 * Silence, not duration.
 *
 * A CLI turn can legitimately run for hours — a long refactor streams tool
 * activity the whole way — so this is an INACTIVITY clock, reset by every chunk
 * that arrives. As a single timer around the whole turn it killed CLIs that
 * were working perfectly well and then told the user they had "produced nothing
 * for 20 minutes", which was the one thing that had not happened.
 */
export const SUPERVISED_IDLE_TIMEOUT_MS = 20 * 60_000

export function modeFor(
  info: BackendInfo | null | undefined,
  target?: ComputerTarget
): TurnMode {
  if (info && usesApplicationToolLoop(info.id)) return 'orchestrated'
  if (
    info?.kind === 'agent-cli' &&
    !(target?.kind === 'vm' && info.supportsVmOrchestration === true)
  ) return 'supervised'
  return 'orchestrated'
}

export function supervisedTimeoutMessage(): string {
  const minutes = Math.round(SUPERVISED_IDLE_TIMEOUT_MS / 60_000)
  return (
    `The agent CLI produced nothing for ${minutes} minutes, so the turn was stopped and ` +
    `its process killed. Anything it already reported is kept above.`
  )
}
