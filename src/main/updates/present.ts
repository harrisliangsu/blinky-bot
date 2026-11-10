/**
 * Turn a check into the notification and the download-and-install dialog.
 * Electron stays outside this file so the choices can be tested without a window.
 */

import { fillUpdate, updateCopy, type UpdateLang } from './copy.ts'
import {
  promptButtons,
  promptChoice,
  reminderAfter,
  updatePrompt,
  type OfferPrompt,
  type Reminder,
  type UpdateCandidate
} from './prompt.ts'

export interface UpdatePresenter {
  now(): number
  loadReminder(): Promise<Reminder>
  saveReminder(reminder: Reminder): Promise<void>
  notify(title: string, body: string, onClick: () => Promise<void> | void): void
  /** Dialog button index. A missing button is treated as Later. */
  ask(offer: OfferPrompt): Promise<number>
  tell(title: string, message: string): Promise<void>
  openExternal(url: string): Promise<void>
  downloadAndInstall(candidate: UpdateCandidate): Promise<{ ok: boolean; message: string; remind?: 'later' }>
}

export async function presentUpdate(
  origin: 'scheduled' | 'manual',
  candidate: UpdateCandidate,
  presenter: UpdatePresenter,
  lang: UpdateLang
): Promise<void> {
  const state = { busy: false }
  const copy = updateCopy(lang)

  async function run(next: 'scheduled' | 'manual', notifyUser: boolean): Promise<void> {
    if (state.busy) return
    state.busy = true
    try {
      const reminder = await presenter.loadReminder()
      const prompt = updatePrompt({ origin: next, candidate, reminder, now: presenter.now() })
      if (prompt.kind === 'silent') return
      if (prompt.kind === 'up-to-date') {
        await presenter.tell(copy.upToDateTitle, fillUpdate(copy.upToDateMessage, { version: prompt.current }))
        return
      }
      if (prompt.kind === 'empty') {
        await presenter.tell(copy.emptyTitle, prompt.channel === 'beta' ? copy.noBeta : copy.emptyFeed)
        return
      }
      if (prompt.kind === 'error') {
        await presenter.tell(copy.errorTitle, prompt.message)
        return
      }
      if (notifyUser) {
        presenter.notify(fillUpdate(copy.notifyTitle, { version: prompt.version }), copy.notifyBody, () => run('manual', false))
      }
      const choice = promptChoice(promptButtons(prompt.action), await presenter.ask(prompt))
      if (choice === 'later' || choice === 'skip') {
        await presenter.saveReminder(reminderAfter(choice, prompt.version, presenter.now(), reminder))
        return
      }
      if (choice === 'open') {
        if (prompt.url) await presenter.openExternal(prompt.url)
        await presenter.saveReminder(reminderAfter('later', prompt.version, presenter.now(), reminder))
        return
      }
      presenter.notify(fillUpdate(copy.downloadingTitle, { version: prompt.version }), copy.downloadingBody, () => undefined)
      const result = await presenter.downloadAndInstall(candidate)
      if (result.remind === 'later') await presenter.saveReminder(reminderAfter('later', prompt.version, presenter.now(), reminder))
      if (!result.ok && result.message) await presenter.tell(copy.installFailedTitle, result.message)
    } finally {
      state.busy = false
    }
  }

  await run(origin, true)
}
