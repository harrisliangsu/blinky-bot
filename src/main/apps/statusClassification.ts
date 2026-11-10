export interface CommandProbe { ok: boolean; stdout: string; stderr: string; code?: number }

export function gitProbeFailed(probe: CommandProbe): boolean {
  // git config --get returns 1 when the key does not exist.
  return !probe.ok && probe.code !== 1
}
