/**
 * Guest-side execution daemon.
 *
 * Run this process inside the bot VM and expose its loopback listener through
 * the VM supervisor's private tunnel. It deliberately implements only health
 * and approval-preserving box RPC (files, shell, fetch, and web search). When
 * Chromium is configured it also exposes the small authenticated computer API;
 * VM lifecycle remains the desktop supervisor's responsibility.
 *
 * This file is a build entry point, so it stays where it is and keeps only what
 * belongs to the process itself: routing, backend selection, and shutdown. The
 * pieces it routes to live beside it in `./guest`.
 */

import { mkdir } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { VM_BOX_CAPABILITIES } from './tools/computer/vmProtocol'
import { authorised } from './guest/auth'
import { execute, normaliseToolRequest } from './guest/boxTools'
import { ChromiumComputer } from './guest/chromiumComputer'
import { handleComputer, type GuestComputer } from './guest/computerRoutes'
import {
  BIND_HOST,
  BOX_ROOT,
  CHROMIUM_BIN,
  CHROMIUM_PORT,
  DESKTOP_ENABLED,
  MAX_TOOL_BYTES,
  PORT,
  VM_ID
} from './guest/config'
import { DesktopComputer } from './guest/desktopComputer'
import { HttpError, json, readBody } from './guest/http'

export { approvalSignature } from './guest/boxTools'

let computer: GuestComputer | undefined
let server: ReturnType<typeof createServer>

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorised(req)) {
    json(res, 401, { error: 'Invalid VM id or bearer token.' })
    return
  }

  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (req.method === 'GET' && url.pathname === '/health') {
    const computerReady = computer?.ready === true
    json(res, 200, {
      ok: true,
      detail: `BlinkyBot guest execution daemon for ${VM_ID}.`,
      capabilities: [
        ...VM_BOX_CAPABILITIES,
        ...(computerReady ? ['computer-v1'] : []),
        ...(computerReady && DESKTOP_ENABLED ? ['desktop-v1'] : [])
      ]
    })
    return
  }

  if (computer && await handleComputer(computer, req, res, url.pathname)) return

  if (req.method === 'POST' && url.pathname === '/box/tool') {
    const raw = await readBody(req, MAX_TOOL_BYTES)
    const request = normaliseToolRequest(JSON.parse(raw) as unknown)
    const controller = new AbortController()
    const abort = (): void => {
      if (!res.writableEnded) controller.abort(new DOMException('client disconnected', 'AbortError'))
    }
    req.once('aborted', abort)
    res.once('close', abort)
    try {
      json(res, 200, await execute(request, controller.signal))
    } finally {
      req.off('aborted', abort)
      res.off('close', abort)
    }
    return
  }

  json(res, 404, { error: 'No such VM daemon endpoint.' })
}

async function boot(): Promise<void> {
  await mkdir(BOX_ROOT, { recursive: true })
  computer = CHROMIUM_BIN
    ? DESKTOP_ENABLED
      ? new DesktopComputer(CHROMIUM_BIN, BOX_ROOT)
      : new ChromiumComputer(CHROMIUM_BIN, CHROMIUM_PORT, BOX_ROOT)
    : undefined
  await computer?.start().catch((error) => console.error('[openbot/vm-daemon] computer did not start', error))

  server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      // A refused request is not a broken daemon: it answers with its own
      // status and message so the caller can tell "too big" from "went wrong".
      if (error instanceof HttpError) {
        json(res, error.status, { error: error.message })
        return
      }
      console.error('[openbot/vm-daemon] request failed', error)
      json(res, 500, { error: 'The VM daemon could not complete the request.' })
    })
  })
  server.headersTimeout = 10_000
  server.requestTimeout = 30_000
  server.maxRequestsPerSocket = 100
  server.listen(PORT, BIND_HOST, () => {
    console.log(`[openbot/vm-daemon] ${VM_ID} listening on http://${BIND_HOST}:${PORT}`)
    console.log(`[openbot/vm-daemon] workspace ${BOX_ROOT}`)
  })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      computer?.stop()
      server.close(() => process.exit(0))
    })
  }
}

await boot()
