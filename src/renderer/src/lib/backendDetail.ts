/**
 * Settings shows detection text from the main process. Those sentences are
 * English. This maps the known ones onto the active settings copy.
 */

import { englishArticle } from '../../../shared/englishArticle'
import type { SettingsCopy } from './settingsCopy'

type DetailCopy = SettingsCopy['backends']['detail']

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '')
}

function localizeInstall(hint: string, detail: DetailCopy): string {
  const bundled = hint.match(/^Install with (.+)\.$/)
  if (bundled) return fill(detail.installWith, { options: bundled[1].replaceAll(' or ', detail.installOr) })
  const page = hint.match(/^Install it from (\S+)\.$/)
  if (page) return fill(detail.installFrom, { url: page[1] })
  if (hint === 'Not installed.') return detail.notInstalled
  return hint
}

/** The sentence under a backend row, in the settings language. */
export function localizeBackendDetail(detail: string, copy: DetailCopy): string {
  const needsKey = detail.match(
    /^API key required — add an? (.+?) key in Settings \((.+?)\)\. It is stored locally, encrypted by the OS credential store, and sent only to (.+)'s own API host\.$/
  )
  if (needsKey && needsKey[1] === needsKey[3]) {
    return fill(copy.needsKey, { article: englishArticle(needsKey[1]), label: needsKey[1], hint: needsKey[2] })
  }

  const missing = detail.match(/^`([^`]+)` was not found on your PATH\. (.*)$/)
  if (missing) return fill(copy.notFound, { command: missing[1], install: localizeInstall(missing[2], copy) })

  const setCommand = detail.match(/^Set a command for (.+) in Settings — any binary speaking its protocol works\.$/)
  if (setCommand) return fill(copy.setCommand, { name: setCommand[1] })

  const timeout = detail.match(
    /^(.+) did not answer a version check within the probe window — it may be waiting on first-run setup\. Run `([^`]+)` once in a terminal\.$/
  )
  if (timeout) return fill(copy.versionTimeout, { name: timeout[1], command: timeout[2] })

  const signIn = detail.match(/^(.+?) is installed( \([^)]+\))? but has no configuration yet — run `([^`]+)` once and sign in\.$/)
  if (signIn) return fill(copy.needsSignIn, { name: signIn[1], where: signIn[2] ?? '', command: signIn[3] })

  const kimi = detail.match(/^(.+) is installed but not signed in\. Run `([^`]+) login` in a terminal, then refresh\.$/)
  if (kimi) return fill(copy.kimiSignIn, { name: kimi[1], command: kimi[2] })

  const grokKey = detail.match(/^(.+) is installed\. The API key saved on this row is passed as XAI_API_KEY\.$/)
  if (grokKey) return fill(copy.grokKey, { name: grokKey[1] })

  const grok = detail.match(
    /^(.+) is installed but not signed in\. Run `([^`]+) login` in a terminal, or save an xAI API key on this row\.$/
  )
  if (grok) return fill(copy.grokSignIn, { name: grok[1], command: grok[2] })

  const found = detail.match(/^(.+?) found( \([^)]+\))?\.$/)
  if (found) return fill(copy.found, { name: found[1], where: found[2] ?? '' })

  const models = detail.match(/^Key accepted — (\d+) models? available\.$/)
  if (models) {
    const count = models[1]
    return fill(copy.keyAcceptedModels, { count, suffix: count === '1' ? '' : 's' })
  }
  if (detail === 'Key accepted.') return copy.keyAccepted
  if (detail === 'Disabled in Settings.') return copy.disabled
  if (detail === 'Detection timed out.') return copy.timedOut
  if (detail === 'Not checked yet.') return copy.notChecked

  const offline = detail.match(/^Could not reach (.+) — check your network connection\.$/)
  if (offline) return fill(copy.unreachable, { host: offline[1] })

  const failed = detail.match(/^(.+?) check failed: (.*)$/)
  if (failed) return fill(copy.checkFailed, { label: failed[1], error: failed[2] })

  return detail
}
