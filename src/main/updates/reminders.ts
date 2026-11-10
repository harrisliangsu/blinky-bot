/** Skip and Later survive a relaunch. A broken file means "ask again", not "never ask". */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { emptyReminder, type Reminder } from './prompt.ts'

export async function readReminder(path: string): Promise<Reminder> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as { skippedVersion?: unknown; laterUntil?: unknown }
    const skipped = typeof parsed.skippedVersion === 'string' ? parsed.skippedVersion.trim() : ''
    const later = typeof parsed.laterUntil === 'number' && Number.isFinite(parsed.laterUntil) ? parsed.laterUntil : null
    return { skippedVersion: skipped || null, laterUntil: later }
  } catch {
    return emptyReminder()
  }
}

export async function writeReminder(path: string, reminder: Reminder): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify({ skippedVersion: reminder.skippedVersion, laterUntil: reminder.laterUntil }), 'utf8')
}
