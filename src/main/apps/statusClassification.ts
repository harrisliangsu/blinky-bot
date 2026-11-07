export interface CommandProbe { ok: boolean; stdout: string; stderr: string; code?: number }

// gh writes its status to stderr. Only its explicit no-account response is
// treated as disconnected; errors and expired/invalid credentials require a
// fresh authentication check and must not be confused with no saved login.
export function githubProbeState(probe: CommandProbe): 'connected' | 'disconnected' | 'unavailable' {
  if (probe.ok) return 'connected'
  if (/not logged into any github hosts/i.test(`${probe.stdout}\n${probe.stderr}`)) return 'disconnected'
  return 'unavailable'
}

export function gitProbeFailed(probe: CommandProbe): boolean {
  // git config --get returns 1 when the key does not exist.
  return !probe.ok && probe.code !== 1
}
