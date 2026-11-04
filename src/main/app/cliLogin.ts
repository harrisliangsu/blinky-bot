/**
 * Open the CLI's own login in Terminal.app.
 *
 * The command is the CLI's documented sign-in (`codex login`, `claude auth
 * login`, …). Terminal keeps the user's login shell, so the browser OAuth
 * and the credential file stay with that CLI. BlinkyBot only watches an exit
 * code written beside the process, then asks the CLI for its status again.
 */

import { execFile } from 'node:child_process'
import { type FSWatcher, mkdirSync, watch } from 'node:fs'
import { access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import { AGENT_CLI_SPECS } from '../backends/cli'
import { authMethod, loginTerminalCommand } from '../backends/cli/authStatus'
import { commandFor } from '../backends/cli/spec'
import { hydratedEnv } from '../backends/loginShellEnv'
import { which } from '../backends/which'
import { broadcast } from '../ipc/broadcast'
import { recheckBackend } from '../ipc/backendRegistry'
import { getSettings } from '../settings'

const run = promisify(execFile)

const pending = new Set<string>()
const watchers = new Map<string, { watcher: FSWatcher; timer: ReturnType<typeof setTimeout> }>()
let focusHooked = false

const TERMINAL_SCRIPT = `function run(argv) {
  const terminal = Application('Terminal')
  terminal.activate()
  terminal.doScript(argv[0])
}`

function sentinelPath(id: string): string {
  return join(tmpdir(), 'blinkybot-cli-login', `${id}.exit`)
}

let publishChain: Promise<void> = Promise.resolve()

function publish(id: string): Promise<void> {
  const run = publishChain
    .then(async () => {
      const backends = await recheckBackend(id)
      broadcast({ type: 'backends-updated', backends })
    })
    .catch((err) => {
      console.error('[openbot/cli] login refresh failed', err)
    })
  publishChain = run
  return run
}

function hookFocus(): void {
  if (focusHooked) return
  focusHooked = true
  app.on('browser-window-focus', () => {
    for (const id of pending) void publish(id)
  })
}

function stopWatch(id: string): void {
  const current = watchers.get(id)
  if (!current) return
  clearTimeout(current.timer)
  current.watcher.close()
  watchers.delete(id)
}

function watchSentinel(id: string, file: string): void {
  stopWatch(id)
  const dir = join(tmpdir(), 'blinkybot-cli-login')
  mkdirSync(dir, { recursive: true })
  const timer = setTimeout(() => {
    pending.delete(id)
    stopWatch(id)
  }, 15 * 60 * 1000)
  timer.unref?.()
  const watcher = watch(dir, () => {
    access(file)
      .then(() => {
        pending.delete(id)
        stopWatch(id)
        void publish(id)
      })
      .catch(() => undefined)
  })
  watchers.set(id, { watcher, timer })
}

/** Launch Terminal with this CLI's official login. Never stores a token. */
export async function startCliLogin(id: string): Promise<{ started: boolean }> {
  const spec = AGENT_CLI_SPECS.find((entry) => entry.id === id)
  const method = authMethod(id)
  if (!spec || !method || process.platform !== 'darwin') return { started: false }
  const cfg = getSettings().backends[id] ?? { enabled: true }
  const command = commandFor(spec, cfg)
  const binary = await which(command)
  if (!binary) return { started: false }

  const file = sentinelPath(id)
  const script = loginTerminalCommand(binary, method.loginArgs, file)
  hookFocus()
  pending.add(id)
  watchSentinel(id, file)
  try {
    await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', TERMINAL_SCRIPT, script], {
      timeout: 15_000,
      env: await hydratedEnv()
    })
    return { started: true }
  } catch (err) {
    pending.delete(id)
    stopWatch(id)
    console.error('[openbot/cli] could not open Terminal for login', err)
    return { started: false }
  }
}
