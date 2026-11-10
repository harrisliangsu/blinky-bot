import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { writeJsonNow } from '../store/jsonStore'
import type { RoutineLauncherStatus } from './routineLauncher'

const exec = promisify(execFile)
interface Owner { version: 1; label: string; hash: string }
export interface RoutineJobOptions { label: string; plistPath: string; markerPath: string; bundle: string; enabled: boolean; uid: number; testEnvironment?: Record<string, string> }
function xml(value: string): string { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;') }
export function routineJobPlist(label: string, bundle: string, testEnvironment?: Record<string, string>): string {
  // The production caller supplies no overrides. Tests use a temporary data
  // root to exercise LaunchServices without touching any real user session.
  const testArgs = Object.entries(testEnvironment ?? {}).flatMap(([key, value]) => ['--env', `${key}=${value}`])
  const args = ['/usr/bin/open', '-n', '-g', '-j', ...testArgs, '-a', bundle, '--args', '--routine-runner'].map((arg) => `<string>${xml(arg)}</string>`).join('')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array>${args}</array><key>StartInterval</key><integer>60</integer></dict></plist>\n`
}
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
async function readOptional(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}
async function launchctl(...args: string[]): Promise<boolean> {
  try { await exec('/bin/launchctl', args, { timeout: 10000, maxBuffer: 1024 * 1024 }); return true } catch { return false }
}
async function loadedJob(service: string, plistPath: string, fileExists: boolean): Promise<'absent' | 'owned' | 'foreign'> {
  let stdout: string
  try {
    const result = await exec('/bin/launchctl', ['print', service], { timeout: 10000, maxBuffer: 1024 * 1024 })
    stdout = result.stdout
  } catch (error) {
    if ((error as { code?: number }).code === 113) return 'absent'
    throw new Error('The background task status could not be checked.')
  }
  const reported = /^\s*path = (.+)$/m.exec(stdout)?.[1]?.trim()
  if (!reported || !fileExists) return 'foreign'
  try {
    const [actual, expected] = await Promise.all([realpath(reported), realpath(plistPath)])
    return actual === expected ? 'owned' : 'foreign'
  } catch { return 'foreign' }
}

/** Exported for isolated tests with a unique label and temporary files. */
export async function reconcileRoutineJob(options: RoutineJobOptions): Promise<RoutineLauncherStatus> {
  const { label, plistPath, markerPath, bundle, enabled, uid } = options
  const service = `gui/${uid}/${label}`, domain = `gui/${uid}`
  const markerText = await readOptional(markerPath), current = await readOptional(plistPath)
  let owner: Owner | null = null
  if (markerText) {
    try { owner = JSON.parse(markerText) as Owner } catch { throw new Error('Background routine ownership record is damaged.') }
    if (owner.version !== 1 || owner.label !== label || !/^[a-f0-9]{64}$/.test(owner.hash)) throw new Error('Background routine ownership record is invalid.')
  }
  if (current && (!owner || hash(current) !== owner.hash)) throw new Error('A different background task uses the BlinkyBot routine path; it was not changed.')
  let job = await loadedJob(service, plistPath, Boolean(current))
  if (job === 'foreign') throw new Error('Another background task uses the BlinkyBot routine label; it was not changed.')
  if (!enabled) {
    if (!owner) return { state: 'inactive' }
    if (job === 'owned') {
      if (!await launchctl('bootout', service) && await loadedJob(service, plistPath, true) !== 'absent') throw new Error('The background routine task could not be stopped.')
    }
    if (current) {
      if (hash((await readOptional(plistPath)) ?? '') !== owner.hash) throw new Error('The background task changed and was not removed.')
      await unlink(plistPath)
    }
    await unlink(markerPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
    return { state: 'inactive' }
  }
  const desired = routineJobPlist(label, bundle, options.testEnvironment), desiredHash = hash(desired)
  if (current && hash(current) !== desiredHash) {
    if (job === 'owned') {
      if (!await launchctl('bootout', service) && await loadedJob(service, plistPath, true) !== 'absent') throw new Error('The old background routine task could not be updated.')
    }
    if (hash((await readOptional(plistPath)) ?? '') !== owner?.hash) throw new Error('The background task changed and was not updated.')
    await unlink(plistPath)
    job = 'absent'
  }
  if (!current || hash(current) !== desiredHash) {
    await mkdir(dirname(plistPath), { recursive: true })
    // The ownership marker is durable before creating the job. If another file
    // appears concurrently, exclusive creation refuses to replace it.
    await writeJsonNow(markerPath, { version: 1, label, hash: desiredHash } satisfies Owner)
    await writeFile(plistPath, desired, { flag: 'wx', mode: 0o600 })
  }
  if (job === 'absent') {
    if (!await launchctl('bootstrap', domain, plistPath) && await loadedJob(service, plistPath, true) !== 'owned') throw new Error('macOS did not start the background routine task.')
  }
  return { state: 'active' }
}

