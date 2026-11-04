/**
 * Ask GitHub whether a newer BlinkyBot build exists.
 *
 * Stable reads the Sparkle appcast the release workflow publishes.
 * Beta reads the GitHub releases API and only reports a prerelease.
 */

import { app } from 'electron'
import { decideUpdate, pickRelease, readSparkleItem, type UpdateDecision } from './sparkleFeed'

const APPCAST = 'https://github.com/harrisliangsu/blinky-bot/releases/latest/download/appcast.xml'
const RELEASES = 'https://api.github.com/repos/harrisliangsu/blinky-bot/releases?per_page=20'

export interface UpdateReport extends UpdateDecision {
  channel: 'stable' | 'beta'
}

async function fetchText(url: string, accept: string): Promise<string> {
  const response = await fetch(url, {
    headers: { Accept: accept, 'User-Agent': 'BlinkyBot' },
    signal: AbortSignal.timeout(12_000)
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return await response.text()
}

export async function checkForUpdate(channel: 'stable' | 'beta'): Promise<UpdateReport> {
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
        picked ? { version: picked.version, url: picked.url } : null,
        'No beta release is published.'
      )
      return { ...decision, channel }
    }
    const xml = await fetchText(APPCAST, 'application/rss+xml, application/xml, text/xml')
    return { ...decideUpdate(current, readSparkleItem(xml), 'The update feed had no version.'), channel }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The update check failed.'
    return {
      channel,
      current,
      latest: null,
      url: null,
      updateAvailable: false,
      note: message
    }
  }
}

export function currentAppVersion(): string {
  return app.getVersion()
}
