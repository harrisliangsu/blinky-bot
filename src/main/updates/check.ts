/**
 * Ask GitHub whether a newer BlinkyBot build exists.
 *
 * Stable reads the Sparkle appcast the release workflow publishes.
 * Beta reads the GitHub releases API and only reports a prerelease.
 */

import { app } from 'electron'
import type { UpdateCandidate } from './prompt'
import { decideUpdate, pickRelease, readSparkleItem } from './sparkleFeed'

const APPCAST = 'https://github.com/harrisliangsu/blinky-bot/releases/latest/download/appcast.xml'
const RELEASES = 'https://api.github.com/repos/harrisliangsu/blinky-bot/releases?per_page=20'

async function fetchText(url: string, accept: string): Promise<string> {
  const response = await fetch(url, {
    headers: { Accept: accept, 'User-Agent': 'BlinkyBot' },
    signal: AbortSignal.timeout(12_000)
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return await response.text()
}

export async function checkForUpdate(channel: 'stable' | 'beta', language: 'en' | 'zh-CN' = 'en'): Promise<UpdateCandidate> {
  const current = app.getVersion()
  try {
    if (channel === 'beta') {
      const body = await fetchText(RELEASES, 'application/vnd.github+json')
      const parsed = JSON.parse(body) as Array<{
        tag_name?: string
        html_url?: string
        prerelease?: boolean
        draft?: boolean
      }>
      const releases = parsed
        .filter((release) => release.draft !== true && release.tag_name && release.html_url)
        .map((release) => ({
          version: String(release.tag_name).replace(/^v/i, ''),
          url: String(release.html_url),
          prerelease: release.prerelease === true
        }))
      const picked = pickRelease(releases, 'beta')
      const decision = decideUpdate(
        current,
        picked ? { version: picked.version, url: picked.url, edSignature: null, length: null, notes: '' } : null,
        'No beta release is published.'
      )
      return candidate(channel, decision, null, decision.latest ? (decision.updateAvailable ? 'update' : 'current') : 'empty')
    }
    const xml = await fetchText(APPCAST, 'application/rss+xml, application/xml, text/xml')
    const item = readSparkleItem(xml, language)
    const decision = decideUpdate(current, item, 'The update feed had no version.')
    const status = item ? (decision.updateAvailable ? 'update' : 'current') : 'empty'
    return candidate(channel, decision, item, status)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The update check failed.'
    return {
      channel,
      current,
      latest: null,
      url: null,
      updateAvailable: false,
      note: message,
      status: 'error',
      edSignature: null,
      length: null,
      notes: ''
    }
  }
}

function candidate(
  channel: 'stable' | 'beta',
  decision: { current: string; latest: string | null; url: string | null; updateAvailable: boolean; note: string },
  item: { edSignature: string | null; length: number | null; notes: string } | null,
  status: UpdateCandidate['status']
): UpdateCandidate {
  return {
    channel,
    current: decision.current,
    latest: decision.latest,
    url: decision.url,
    updateAvailable: decision.updateAvailable,
    note: decision.note,
    status,
    edSignature: item?.edSignature ?? null,
    length: item?.length ?? null,
    notes: item?.notes ?? ''
  }
}

export function currentAppVersion(): string {
  return app.getVersion()
}
