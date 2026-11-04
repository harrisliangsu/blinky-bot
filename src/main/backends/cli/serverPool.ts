/**
 * Server transport: start `<cli> serve --port 0`, discover the real URL by
 * scraping the ready line, and keep the process pooled.
 *
 * Port 0 means the OS assigns the port, so the URL is always read back from the
 * CLI rather than assumed. Servers are ref-counted per {binary, cwd, args} and
 * closed after an idle period, so consecutive turns reuse one process.
 */

import { createHash } from 'node:crypto'
import { diagnosticTail } from '../secretRedaction'
import { type ProcessHandle, spawnLines } from '../spawnProcess'
import { stopWarmCodex } from './codexAppServer'
import type { AgentCliSpec } from './spec'

const READY_TIMEOUT_MS = 20_000
const IDLE_CLOSE_MS = 5 * 60_000
const MAX_DIAGNOSTIC_LINES = 200

export interface PooledServer {
  key: string
  baseUrl: string
  handle: ProcessHandle
  refs: number
  idleTimer?: ReturnType<typeof setTimeout>
}

export interface ServerRequest {
  spec: AgentCliSpec
  binaryPath: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  /** Values merged over the hydrated login-shell environment. */
  extraEnv?: NodeJS.ProcessEnv
}

const pool = new Map<string, Promise<PooledServer>>()

/** Live servers, for the last-resort shutdown below. */
const running = new Set<PooledServer>()

/*
 * Last-resort net: `stopAgentCliServers` is the graceful path, but a quit that
 * never reaches it — or a crash — would leave `<cli> serve` running with no
 * parent. `exit` handlers must be synchronous, and signalling is, so the pooled
 * servers are killed here rather than left behind.
 */
let exitHookInstalled = false
function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once('exit', () => {
    for (const server of running) {
      try {
        server.handle.kill()
      } catch {
        // Exiting anyway.
      }
    }
    running.clear()
  })
}

function poolKey(req: ServerRequest): string {
  // Environment-backed inline config can contain a per-turn MCP bearer token.
  // Reusing a server across two such environments would preserve the old bot's
  // grants and tools. Hash it so secrets do not live in the map key itself.
  const envKey = createHash('sha256')
    .update(JSON.stringify([req.env ?? null, req.extraEnv ?? null]))
    .digest('hex')
  return JSON.stringify([req.binaryPath, req.cwd, req.args, envKey])
}

/**
 * Drop a pool entry only when it still points at this server. A stale handle
 * whose idle timer fires late must not evict the *replacement* that took its
 * key, which would orphan a live, referenced server.
 */
function forget(server: PooledServer): void {
  running.delete(server)
  const entry = pool.get(server.key)
  if (!entry) return
  void entry.then(
    (current) => {
      if (current === server) pool.delete(server.key)
    },
    () => pool.delete(server.key)
  )
}

/** The ready line names the URL, including the OS-assigned port. */
export function matchReadyUrl(spec: AgentCliSpec, line: string): string | null {
  const prefix = spec.serverReadyPrefix
  if (prefix && !line.toLowerCase().includes(prefix.toLowerCase())) return null
  const onMatch = /on\s+(https?:\/\/[^\s]+)/i.exec(line)
  if (onMatch) return onMatch[1].replace(/[.,]$/, '')
  const bare = /(https?:\/\/[^\s]+)/i.exec(line)
  return bare ? bare[1].replace(/[.,]$/, '') : null
}

async function start(req: ServerRequest, key: string): Promise<PooledServer> {
  const handle = await spawnLines(req.binaryPath, {
    args: req.args,
    cwd: req.cwd,
    env: req.env,
    extraEnv: req.extraEnv,
    stdin: 'ignore'
  })

  const diagnostics: string[] = []
  let resolveReady: (url: string) => void = () => undefined
  const ready = new Promise<string>((resolve) => {
    resolveReady = resolve
  })

  void (async () => {
    for await (const { line } of handle.lines) {
      if (!line.trim()) continue
      diagnostics.push(line)
      if (diagnostics.length > MAX_DIAGNOSTIC_LINES) diagnostics.shift()
      const url = matchReadyUrl(req.spec, line)
      if (url) resolveReady(url)
    }
  })().catch(() => undefined)

  const failure = (reason: string): Error => {
    const tail = diagnosticTail(diagnostics.join('\n'))
    return new Error(`${req.spec.displayName} ${reason}${tail ? `:\n${tail}` : '.'}`)
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(failure(`did not report a server URL within ${READY_TIMEOUT_MS / 1000}s`)),
      READY_TIMEOUT_MS
    )
  })
  const died = handle.exit.then((info) => {
    throw failure(
      info.error ? `failed to start (${info.error.message})` : `exited with code ${info.code}`
    )
  })

  try {
    const baseUrl = await Promise.race([ready, timeout, died])
    const server: PooledServer = { key, baseUrl: baseUrl.replace(/\/+$/, ''), handle, refs: 0 }
    installExitHook()
    running.add(server)
    // A server that dies on its own must leave the pool, or every later turn
    // is handed a dead handle until something else evicts it.
    void handle.exit.then(() => forget(server))
    return server
  } catch (err) {
    handle.kill()
    throw err
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function acquireServer(req: ServerRequest): Promise<PooledServer> {
  const key = poolKey(req)
  let entry = pool.get(key)
  if (!entry) {
    entry = start(req, key)
    pool.set(key, entry)
    entry.catch(() => {
      if (pool.get(key) === entry) pool.delete(key)
    })
  }

  const server = await entry
  // A server that died between turns must not be handed out again.
  if (server.handle.child.exitCode !== null || server.handle.child.killed) {
    forget(server)
    if (pool.get(key) === entry) pool.delete(key)
    return acquireServer(req)
  }

  server.refs++
  if (server.idleTimer) {
    clearTimeout(server.idleTimer)
    server.idleTimer = undefined
  }
  return server
}

export function releaseServer(server: PooledServer, options: { immediate?: boolean } = {}): void {
  server.refs = Math.max(0, server.refs - 1)
  if (server.refs === 0 && options.immediate) {
    if (server.idleTimer) clearTimeout(server.idleTimer)
    server.idleTimer = undefined
    forget(server)
    server.handle.kill()
    return
  }
  if (server.refs > 0 || server.idleTimer) return
  server.idleTimer = setTimeout(() => {
    server.idleTimer = undefined
    if (server.refs > 0) return
    forget(server)
    server.handle.kill()
  }, IDLE_CLOSE_MS)
  server.idleTimer.unref?.()
}

/** A server already running for this request, without starting one. */
export async function runningServer(req: ServerRequest): Promise<PooledServer | null> {
  const entry = pool.get(poolKey(req))
  if (!entry) return null
  try {
    return await entry
  } catch {
    return null
  }
}

/** Shut every pooled server down (app quit). */
export async function stopAgentCliServers(): Promise<void> {
  stopWarmCodex()
  const entries = [...pool.values()]
  pool.clear()
  await Promise.all(
    entries.map(async (entry) => {
      try {
        const server = await entry
        if (server.idleTimer) clearTimeout(server.idleTimer)
        server.idleTimer = undefined
        running.delete(server)
        server.handle.kill()
      } catch {
        // Never started — nothing to stop.
      }
    })
  )
}
