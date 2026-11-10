/**
 * What the user sees after a check.
 *
 * A scheduled check stays quiet unless a newer build is actually available
 * and the user has not skipped it or asked to be reminded later. Check now
 * always answers: the offer, up to date, or the error. The offer notifies
 * and asks to download and install, which is the same pair Blinky Mac shows
 * for a Sparkle update.
 */

import { isBlinkyReleaseArchive, isBlinkyReleasePage, MAX_ARCHIVE_BYTES } from './download.ts'
import { isEd25519Signature } from './signature.ts'
import { compareVersions } from './sparkleFeed.ts'

/** `SUScheduledCheckInterval` in the packaged Info.plist: 12 hours. */
export const UPDATE_CHECK_INTERVAL_MS = 43_200_000

export interface UpdateCandidate {
  status: 'update' | 'current' | 'empty' | 'error'
  channel: 'stable' | 'beta'
  current: string
  latest: string | null
  url: string | null
  updateAvailable: boolean
  note: string
  edSignature: string | null
  length: number | null
  notes: string
}

export interface Reminder {
  skippedVersion: string | null
  laterUntil: number | null
}

export type UpdateChoice = 'install' | 'open' | 'later' | 'skip'

export interface OfferPrompt {
  kind: 'offer'
  version: string
  current: string
  notes: string
  url: string
  action: 'install' | 'open' | 'none'
}

export type UpdatePrompt =
  | { kind: 'silent' }
  | { kind: 'up-to-date'; current: string }
  | { kind: 'empty'; channel: 'stable' | 'beta' }
  | { kind: 'error'; message: string }
  | OfferPrompt

const EMPTY_REMINDER: Reminder = { skippedVersion: null, laterUntil: null }

export function emptyReminder(): Reminder {
  return { ...EMPTY_REMINDER }
}

export function archiveLengthAllowed(length: number | null): boolean {
  if (length == null) return true
  return Number.isSafeInteger(length) && length > 0 && length <= MAX_ARCHIVE_BYTES
}

/** A stable Sparkle item can be installed only when the zip is signed and the URL is ours. */
export function canInstallArchive(candidate: Pick<UpdateCandidate, 'status' | 'url' | 'edSignature' | 'length'>): boolean {
  return (
    candidate.status === 'update' &&
    isBlinkyReleaseArchive(candidate.url ?? '') &&
    isEd25519Signature(candidate.edSignature) &&
    archiveLengthAllowed(candidate.length)
  )
}

export function scheduledOfferHeld(latest: string, reminder: Reminder, now: number): boolean {
  if (reminder.skippedVersion && compareVersions(latest, reminder.skippedVersion) <= 0) return true
  return reminder.laterUntil != null && now < reminder.laterUntil
}

export function clipNotes(notes: string, max = 1400): string {
  const clean = notes.trim()
  if (clean.length <= max) return clean
  return `${clean.slice(0, max - 1).trimEnd()}…`
}

export function updatePrompt(input: {
  origin: 'scheduled' | 'manual'
  candidate: UpdateCandidate
  reminder: Reminder
  now: number
}): UpdatePrompt {
  const { origin, candidate, reminder, now } = input
  if (candidate.status === 'update' && candidate.latest) {
    if (origin === 'scheduled' && scheduledOfferHeld(candidate.latest, reminder, now)) return { kind: 'silent' }
    const action = canInstallArchive(candidate) ? 'install' : isBlinkyReleasePage(candidate.url ?? '') ? 'open' : 'none'
    return {
      kind: 'offer',
      version: candidate.latest,
      current: candidate.current,
      notes: clipNotes(candidate.notes),
      url: candidate.url ?? '',
      action
    }
  }
  if (origin === 'scheduled') return { kind: 'silent' }
  if (candidate.status === 'error') return { kind: 'error', message: candidate.note }
  if (candidate.status === 'current') return { kind: 'up-to-date', current: candidate.current }
  return { kind: 'empty', channel: candidate.channel }
}

export function promptButtons(action: OfferPrompt['action']): UpdateChoice[] {
  if (action === 'install') return ['install', 'later', 'skip']
  if (action === 'open') return ['open', 'later', 'skip']
  return ['later', 'skip']
}

/** A closed dialog is Later, so Escape does not install or skip. */
export function promptChoice(buttons: readonly UpdateChoice[], response: number): UpdateChoice {
  return buttons[response] ?? 'later'
}

export function reminderAfter(choice: 'later' | 'skip', version: string, now: number, previous: Reminder = emptyReminder()): Reminder {
  if (choice === 'skip') return { skippedVersion: version, laterUntil: null }
  return { skippedVersion: previous.skippedVersion, laterUntil: now + UPDATE_CHECK_INTERVAL_MS }
}

export function confirmedInstall(response: number): boolean {
  return response === 0
}
