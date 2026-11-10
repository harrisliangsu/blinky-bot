/**
 * Replace the running BlinkyBot.app after the zip's signature has been checked.
 *
 * The helper waits until this process exits, moves the current bundle aside,
 * copies the new one into place, and puts the old one back if that copy fails.
 * Preview uses a different bundle name, so a stable zip is not written over it.
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { verifySparkleSignature } from './signature.ts'

export function runningAppBundle(execPath: string): string | null {
  if (!execPath.startsWith('/')) return null
  const parts = execPath.split('/').filter((part) => part.length > 0)
  if (parts.at(-2) !== 'MacOS' || parts.at(-3) !== 'Contents') return null
  const name = parts.at(-4)
  if (!name?.endsWith('.app')) return null
  return `/${parts.slice(0, -3).join('/')}`
}

export function canInstallOver(bundlePath: string | null): boolean {
  return bundlePath?.endsWith('/BlinkyBot.app') === true
}

export function findExtractedApp(extractDir: string): string | null {
  let top: string[]
  try {
    top = readdirSync(extractDir)
  } catch {
    return null
  }
  if (top.includes('BlinkyBot.app')) return join(extractDir, 'BlinkyBot.app')
  for (const entry of top) {
    if (!entry || entry.startsWith('.') || entry.includes('/') || entry.includes('\\') || entry === 'BlinkyBot.app') continue
    let nested: string[]
    try {
      nested = readdirSync(join(extractDir, entry))
    } catch {
      continue
    }
    if (nested.includes('BlinkyBot.app')) return join(extractDir, entry, 'BlinkyBot.app')
  }
  return null
}

export function installArguments(pid: number, source: string, target: string, scratch: string): string[] | null {
  if (!Number.isInteger(pid) || pid <= 1) return null
  if (!canInstallOver(source) || !canInstallOver(target) || source === target) return null
  if (!scratch.startsWith('/') || scratch.includes('\0') || scratch.includes('..')) return null
  return [String(pid), source, target, scratch]
}

export function acceptDownloadedArchive(
  bytes: Uint8Array,
  signature: string,
  publicKey: string,
  expectedLength: number | null
): { ok: true } | { ok: false; reason: 'length' | 'signature' } {
  if (expectedLength != null && bytes.byteLength !== expectedLength) return { ok: false, reason: 'length' }
  if (!verifySparkleSignature(bytes, signature, publicKey)) return { ok: false, reason: 'signature' }
  return { ok: true }
}

/**
 * Runs under `ELECTRON_RUN_AS_NODE` after BlinkyBot has quit.
 * Arguments are the pid, the extracted app, the installed app, and the temp directory.
 */
export const INSTALL_HELPER = `const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const pid = Number(process.argv[2])
const source = process.argv[3]
const target = process.argv[4]
const scratch = process.argv[5]
function absApp(value) {
  return typeof value === 'string' && path.isAbsolute(value) && path.basename(value) === 'BlinkyBot.app' && !value.split(path.sep).includes('..')
}
function openApp(appPath) {
  spawnSync('/usr/bin/open', [appPath], { stdio: 'ignore' })
}
if (!Number.isInteger(pid) || pid <= 1 || !absApp(source) || !absApp(target) || source === target) process.exit(2)
const started = Date.now()
function alive() {
  try { process.kill(pid, 0); return true } catch (error) { return Boolean(error && error.code === 'EPERM') }
}
while (alive()) {
  if (Date.now() - started > 90000) {
    openApp(target)
    process.exit(3)
  }
  spawnSync('/bin/sleep', ['0.2'])
}
spawnSync('/bin/sleep', ['0.5'])
const backup = target + '.previous'
fs.rmSync(backup, { recursive: true, force: true })
try { fs.renameSync(target, backup) } catch (error) {
  openApp(target)
  process.exit(4)
}
const copied = spawnSync('/usr/bin/ditto', [source, target], { stdio: 'ignore' })
if (copied.status !== 0) {
  try { fs.renameSync(backup, target) } catch (error) { /* the previous copy remains at backup */ }
  openApp(fs.existsSync(target) ? target : backup)
  process.exit(copied.status || 1)
}
spawnSync('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', target], { stdio: 'ignore' })
const opened = spawnSync('/usr/bin/open', [target], { stdio: 'ignore' })
if (opened.status === 0) fs.rmSync(backup, { recursive: true, force: true })
else openApp(backup)
if (typeof scratch === 'string' && path.isAbsolute(scratch) && !scratch.split(path.sep).includes('..')) fs.rmSync(scratch, { recursive: true, force: true })
process.exit(opened.status === 0 ? 0 : opened.status || 1)
`
