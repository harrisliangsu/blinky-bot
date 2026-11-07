/**
 * Codex's model picker comes from `model/list` on the app-server.
 *
 * `codex` has no supported `models` subcommand. The same process that runs a
 * turn advertises the models this login can actually use, including whether
 * each one accepts images. A hard-coded slug list goes stale the moment the
 * account's catalog moves, so a failed probe leaves the CLI's own default in
 * place rather than inventing names.
 */

import { JsonRpcPeer } from '../jsonRpc'
import { spawnLines } from '../spawnProcess'
import type { ModelInfo } from '../types'
import { parseCodexModelPage } from './codexModelList'

/** Wall clock for the whole probe, inside detection's own budget. */
const LIST_BUDGET_MS = 20_000
const inFlight = new Map<string, Promise<ModelInfo[]>>()

function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`codex app-server did not answer ${what} within ${ms / 1000}s`)), ms)
    timer.unref?.()
  })
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

/**
 * Ask a running-capable Codex binary which models this login can pick.
 * Throws when the process never answers; the caller keeps the CLI default.
 */
export async function listCodexModels(binaryPath: string, cwd: string): Promise<ModelInfo[]> {
  const key = JSON.stringify([binaryPath, cwd])
  const pending = inFlight.get(key)
  if (pending) return pending
  const probe = probeCodexModels(binaryPath, cwd)
  inFlight.set(key, probe)
  try {
    return await probe
  } finally {
    if (inFlight.get(key) === probe) inFlight.delete(key)
  }
}

async function probeCodexModels(binaryPath: string, cwd: string): Promise<ModelInfo[]> {
  const handle = await spawnLines(binaryPath, {
    args: ['app-server'],
    cwd,
    stdin: 'pipe',
    timeoutMs: LIST_BUDGET_MS
  })
  const peer = new JsonRpcPeer((line) => handle.write(`${line}\n`), () => undefined)
  const pump = (async () => {
    try {
      for await (const { stream, line } of handle.lines) {
        if (stream === 'stdout') peer.handleLine(line)
      }
    } catch {
      // The request deadline is the failure the caller sees.
    }
  })()
  void pump

  try {
    await withDeadline(
      peer.request('initialize', {
        clientInfo: { name: 'BlinkyBot', title: 'BlinkyBot', version: '0.1.0' }
      }),
      7_000,
      'initialize'
    )
    peer.notify('initialized')
    const seen = new Set<string>()
    const models: ModelInfo[] = []
    let cursor: string | null = null
    for (let page = 0; page < 5; page++) {
      const result = await withDeadline(
        peer.request<unknown>('model/list', {
          limit: 100,
          includeHidden: false,
          ...(cursor ? { cursor } : {})
        }),
        12_000,
        'model/list'
      )
      const parsed = parseCodexModelPage(result)
      for (const model of parsed.models) {
        if (seen.has(model.id)) continue
        seen.add(model.id)
        models.push(model)
      }
      if (!parsed.nextCursor || parsed.nextCursor === cursor) break
      cursor = parsed.nextCursor
    }
    return models
  } finally {
    peer.close(new Error('codex model list closed'))
    handle.kill()
  }
}
