/**
 * Check the Sparkle feed and, when a newer build is published, tell the user.
 *
 * This build does not embed Sparkle.framework. It reads the same appcast, checks
 * the same Ed25519 signature, and shows a notification plus a download-and-install
 * dialog. Scheduled checks follow `SUScheduledCheckInterval` (12 hours) and also
 * run shortly after launch. Check now uses the same offer.
 */

import { spawn } from 'node:child_process'
import { app, dialog, Notification } from 'electron'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSettings } from '../settings'
import type { UpdateReport } from '../../shared/updates'
import { dataRoot } from '../store/paths'
import { checkForUpdate } from './check'
import { fillUpdate, updateCopy, updateLanguage, type UpdateLang } from './copy'
import { MAX_ARCHIVE_BYTES, downloadReleaseArchive } from './download'
import { INSTALL_HELPER, acceptDownloadedArchive, canInstallOver, findExtractedApp, installArguments, runningAppBundle } from './install'
import { presentUpdate, type UpdatePresenter } from './present'
import { canInstallArchive, confirmedInstall, promptButtons, UPDATE_CHECK_INTERVAL_MS, type UpdateCandidate } from './prompt'
import { openBlinkyRelease } from './releaseLink'
import { readReminder, writeReminder } from './reminders'
import { SPARKLE_PUBLIC_KEY } from './signature'

const REMINDER_FILE = 'update-prompt.json'

function reminderPath(): string {
  return join(dataRoot(), REMINDER_FILE)
}

function currentLanguage(): UpdateLang {
  let system = 'en'
  try {
    system = app.getLocale()
  } catch {
    system = 'en'
  }
  return updateLanguage(getSettings().language, system)
}

function reveal(): void {
  if (process.platform !== 'darwin') return
  app.dock?.show()
  try {
    app.focus({ steal: true })
  } catch {
    /* A missing focus API still leaves the dialog visible. */
  }
}

function reportOf(update: UpdateCandidate): UpdateReport {
  return {
    channel: update.channel,
    current: update.current,
    latest: update.latest,
    url: update.url,
    updateAvailable: update.updateAvailable,
    note: update.note,
    status: update.status,
    installable: canInstallArchive(update)
  }
}

let showing = false
let pending: { origin: 'scheduled' | 'manual'; candidate: UpdateCandidate; lang: UpdateLang } | null = null

function queuePresentation(origin: 'scheduled' | 'manual', candidate: UpdateCandidate, lang: UpdateLang): void {
  if (showing) {
    if (origin === 'manual') pending = { origin, candidate, lang }
    return
  }
  showing = true
  void presentUpdate(origin, candidate, presenter(lang), lang)
    .catch((error) => console.error('[openbot/update] could not present the update', error))
    .finally(() => {
      showing = false
      const next = pending
      pending = null
      if (next) queuePresentation(next.origin, next.candidate, next.lang)
    })
}

function presenter(lang: UpdateLang): UpdatePresenter {
  const copy = updateCopy(lang)
  return {
    now: () => Date.now(),
    loadReminder: () => readReminder(reminderPath()),
    saveReminder: (reminder) => writeReminder(reminderPath(), reminder),
    notify(title, body, onClick) {
      if (!Notification.isSupported()) return
      try {
        const notification = new Notification({ title, body, silent: false })
        notification.on('click', () => {
          reveal()
          void Promise.resolve(onClick()).catch((error) => console.error('[openbot/update] notification click failed', error))
        })
        notification.show()
      } catch (error) {
        console.error('[openbot/update] notification failed', error)
      }
    },
    async ask(offer) {
      reveal()
      const ids = promptButtons(offer.action)
      const buttons = ids.map((id) => copy.buttons[id])
      const later = ids.indexOf('later')
      const { response } = await dialog.showMessageBox({
        type: 'info',
        title: copy.offerTitle,
        message: fillUpdate(copy.offerMessage, { version: offer.version, current: offer.current }),
        detail: offer.notes || undefined,
        buttons,
        defaultId: 0,
        cancelId: later >= 0 ? later : 0,
        noLink: true
      })
      return response
    },
    async tell(title, message) {
      reveal()
      await dialog.showMessageBox({ type: 'info', title, message, buttons: [copy.buttons.ok], defaultId: 0, noLink: true })
    },
    async openExternal(url) {
      await openBlinkyRelease(url)
    },
    downloadAndInstall: (candidate) => downloadAndInstall(candidate, lang)
  }
}

async function downloadAndInstall(candidate: UpdateCandidate, lang: UpdateLang): Promise<{ ok: boolean; message: string; remind?: 'later' }> {
  const copy = updateCopy(lang)
  const target = runningAppBundle(process.execPath)
  if (process.platform !== 'darwin' || !app.isPackaged || !canInstallOver(target)) return { ok: false, message: copy.notPackaged }
  if (!candidate.url || !candidate.edSignature) return { ok: false, message: copy.notInstallable }
  const root = await mkdtemp(join(tmpdir(), 'blinky-update-'))
  let handedOff = false
  try {
    const zip = join(root, 'BlinkyBot.zip')
    const size = await downloadReleaseArchive(candidate.url, zip, candidate.length ?? MAX_ARCHIVE_BYTES)
    if (candidate.length != null && size !== candidate.length) return { ok: false, message: copy.badLength }
    const accepted = acceptDownloadedArchive(new Uint8Array(await readFile(zip)), candidate.edSignature, SPARKLE_PUBLIC_KEY, candidate.length)
    if (!accepted.ok) return { ok: false, message: accepted.reason === 'length' ? copy.badLength : copy.badSignature }
    reveal()
    const ready = await dialog.showMessageBox({
      type: 'info',
      title: copy.readyTitle,
      message: fillUpdate(copy.readyMessage, { version: candidate.latest ?? '' }),
      buttons: [copy.buttons.relaunch, copy.buttons.notNow],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    })
    if (!confirmedInstall(ready.response)) return { ok: true, message: '', remind: 'later' }
    const extract = join(root, 'extract')
    await mkdir(extract)
    const status = await exitCode('/usr/bin/ditto', ['-x', '-k', zip, extract])
    if (status !== 0) return { ok: false, message: copy.installFailed }
    const source = findExtractedApp(extract)
    const args = source && target ? installArguments(process.pid, source, target, root) : null
    if (!args) return { ok: false, message: copy.installFailed }
    const script = join(root, 'install.cjs')
    await writeFile(script, INSTALL_HELPER, 'utf8')
    const child = spawn(process.execPath, [script, ...args], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })
    child.unref()
    handedOff = true
    app.quit()
    return { ok: true, message: '' }
  } catch (error) {
    console.error('[openbot/update] install failed', error)
    return { ok: false, message: copy.installFailed }
  } finally {
    if (!handedOff) await rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
}

function exitCode(command: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' })
    child.once('error', reject)
    child.once('exit', (code) => resolve(code ?? 1))
  })
}

export async function runUpdateCheck(origin: 'scheduled' | 'manual', channel?: 'stable' | 'beta'): Promise<UpdateReport> {
  const selected = channel ?? (getSettings().updateChannel === 'beta' ? 'beta' : 'stable')
  const lang = currentLanguage()
  const update = await checkForUpdate(selected, lang)
  queuePresentation(origin, update, lang)
  return reportOf(update)
}

/** Packaged BlinkyBot on macOS. Smoke, Preview, and the routine runner do not call this. */
export function startAutomaticUpdateChecks(): void {
  const kick = setTimeout(() => {
    void runUpdateCheck('scheduled')
  }, 8_000)
  kick.unref?.()
  const timer = setInterval(() => {
    void runUpdateCheck('scheduled')
  }, UPDATE_CHECK_INTERVAL_MS)
  timer.unref?.()
}
