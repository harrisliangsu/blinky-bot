import { spawn } from 'node:child_process'

const RECEIPT = '__BLINKY_RESULT__'

/** Run one Ego command without exposing its script or output in errors. */
export async function runEgoCommand(
  script: string,
  env: NodeJS.ProcessEnv,
  options: { command?: string; args?: string[]; timeoutMs?: number; maxOutput?: number } = {}
): Promise<unknown> {
  const command = options.command ?? 'ego-browser'
  const args = options.args ?? ['nodejs']
  const timeoutMs = options.timeoutMs ?? 45_000
  const maxOutput = options.maxOutput ?? 20_000_000
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    let reason: 'timeout' | 'overflow' | undefined
    let settled = false
    let forceTimer: ReturnType<typeof setTimeout> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined

    const finish = (error?: Error, result?: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (forceTimer) clearTimeout(forceTimer)
      if (deadline) clearTimeout(deadline)
      if (error) reject(error)
      else resolve(result)
    }
    const stop = (why: 'timeout' | 'overflow'): void => {
      if (reason) return
      reason = why
      child.kill('SIGTERM')
      forceTimer = setTimeout(() => child.kill('SIGKILL'), 1_000)
      // Even a broken child-process implementation must not hold the action
      // queue forever. Its effect may already have happened; callers must inspect.
      deadline = setTimeout(() => finish(new Error('Ego Browser did not stop after the action failed. Inspect the browser state before retrying.')), 3_000)
    }
    const timeout = setTimeout(() => stop('timeout'), timeoutMs)
    const capture = (chunk: string): void => {
      if (reason) return
      output += chunk
      if (output.length > maxOutput) stop('overflow')
    }
    child.stdout.setEncoding('utf8'); child.stdout.on('data', capture)
    child.stderr.setEncoding('utf8'); child.stderr.on('data', capture)
    child.on('error', () => finish(new Error('Ego Browser CLI is unavailable. Install or start Ego Browser and retry.')))
    child.on('close', (code) => {
      if (reason === 'timeout') return finish(new Error('Ego Browser action timed out. Inspect the browser state before retrying.'))
      if (reason === 'overflow') return finish(new Error('Ego Browser returned too much data. Inspect the browser state before retrying.'))
      if (code !== 0) return finish(new Error('Ego Browser did not complete the action. Inspect the browser state before retrying.'))
      const line = output.split('\n').findLast((item) => item.startsWith(RECEIPT))
      if (!line) return finish(new Error('Ego Browser returned no action receipt. Inspect the browser state before retrying.'))
      try { finish(undefined, JSON.parse(line.slice(RECEIPT.length))) }
      catch { finish(new Error('Ego Browser returned an invalid action receipt.')) }
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(script)
  })
}
