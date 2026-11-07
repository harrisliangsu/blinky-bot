/**
 * Availability probe for a CLI: spawn `<binary> --version`, classify the
 * outcome, and pull a version string out of whatever it printed.
 */

import { errorMessage } from './httpErrors'
import { diagnosticTail } from './vaultRedaction'
import { spawnLines } from './spawnProcess'

export type ProbeOutcome = 'missing' | 'timeout' | 'nonzero' | 'success'

export interface VersionProbeResult {
  outcome: ProbeOutcome
  /** A killed process is a startup failure, not proof of invalid credentials. */
  signal?: NodeJS.Signals
  version?: string
  /** Redacted stdout + stderr, safe to show in a status detail. */
  output: string
}

export const VERSION_PROBE_TIMEOUT_MS = 4000

const VERSION_RE = /\bv?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)\b/

export function parseVersion(text: string): string | undefined {
  const m = VERSION_RE.exec(text)
  return m ? m[1] : undefined
}

export async function probeVersion(
  bin: string,
  args: string[] = ['--version'],
  timeoutMs = VERSION_PROBE_TIMEOUT_MS
): Promise<VersionProbeResult> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    const handle = await spawnLines(bin, {
      args,
      stdin: 'ignore',
      signal: controller.signal
    })

    const collected: string[] = []
    const drain = (async () => {
      for await (const { line } of handle.lines) collected.push(line)
    })().catch(() => undefined)

    const info = await handle.exit
    await drain
    const output = diagnosticTail(collected.join('\n'), 600)

    if (info.error) {
      const code = (info.error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') {
        return { outcome: 'missing', output: output || errorMessage(info.error) }
      }
      return { outcome: 'nonzero', output: output || errorMessage(info.error) }
    }
    if (timedOut) return { outcome: 'timeout', output }
    const version = parseVersion(output)
    if (info.code !== 0) return { outcome: 'nonzero', output, ...(info.signal ? { signal: info.signal } : {}), ...(version ? { version } : {}) }
    return { outcome: 'success', output, ...(version ? { version } : {}) }
  } catch (err) {
    return { outcome: 'missing', output: errorMessage(err) }
  } finally {
    clearTimeout(timer)
  }
}
