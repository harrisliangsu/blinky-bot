/**
 * Open an official login command in Terminal.app and remember nothing but
 * the exit code. Used for GitHub (`gh auth login`). CLI logins stay in
 * `cliLogin.ts`; this is the same Terminal handoff for apps.
 */

import { execFile } from 'node:child_process'
import { type FSWatcher, mkdirSync, watch } from 'node:fs'
import { access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { loginTerminalCommand } from '../backends/cli/authStatus'
import { hydratedEnv } from '../backends/loginShellEnv'

const run = promisify(execFile)

const TERMINAL_SCRIPT = `function run(argv) {
  const terminal = Application('Terminal')
  terminal.activate()
  terminal.doScript(argv[0])
}`

function sentinelPath(id: string): string {
  return join(tmpdir(), 'blinkybot-app-login', `${id}.exit`)
}

export async function startExternalLogin(
  id: string,
  binary: string,
  args: readonly string[]
): Promise<{ started: boolean }> {
  if (process.platform !== 'darwin' || !binary) return { started: false }
  const file = sentinelPath(id)
  const script = loginTerminalCommand(binary, args, file)
  const dir = join(tmpdir(), 'blinkybot-app-login')
  mkdirSync(dir, { recursive: true })
  try {
    await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', TERMINAL_SCRIPT, script], {
      timeout: 15_000,
      env: await hydratedEnv()
    })
    watchOnce(dir, file)
    return { started: true }
  } catch (error) {
    console.error('[openbot/apps] could not open Terminal for login', error)
    return { started: false }
  }
}

function watchOnce(dir: string, file: string): void {
  let watcher: FSWatcher | null = null
  const timer = setTimeout(() => watcher?.close(), 15 * 60 * 1000)
  timer.unref?.()
  watcher = watch(dir, () => {
    access(file)
      .then(() => {
        clearTimeout(timer)
        watcher?.close()
      })
      .catch(() => undefined)
  })
}
