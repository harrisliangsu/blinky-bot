/**
 * Packaged-app smoke launch.
 *
 * The release workflow starts the .app with BLINKY_SMOKE=1 and waits until
 * the first window is ready to show. A normal launch never sets the variable.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

function smokeDir(): string | undefined {
  if (process.env.BLINKY_SMOKE !== '1') return undefined
  return process.env.BLINKY_SMOKE_DIR
}

/** Point user data at the smoke directory before the app is ready. */
export function prepareSmoke(): void {
  const dir = smokeDir()
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  if (!process.env.OPENBOT_DATA_DIR) process.env.OPENBOT_DATA_DIR = dir
  app.setPath('userData', dir)
  app.commandLine.appendSwitch('disable-gpu')
}

export function markSmokeReady(): void {
  const dir = smokeDir()
  if (!dir) return
  writeFileSync(join(dir, 'ready'), 'ready\n')
  console.log('[blinky-smoke] ready')
}

export function markSmokeFailed(error: unknown): void {
  const dir = smokeDir()
  if (!dir) return
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
  writeFileSync(join(dir, 'failed'), message)
  console.error('[blinky-smoke] failed')
}
