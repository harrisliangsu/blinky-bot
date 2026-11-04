/**
 * Compare versions and read a Sparkle appcast without fetching it.
 * The network call lives next to this so the rules can be tested offline.
 */

export interface SparkleItem {
  version: string
  url: string
}

export interface ReleaseNote {
  version: string
  url: string
  prerelease: boolean
}

/** Numeric compare. A longer trailing build number wins. Non-numeric suffixes are ignored. */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] =>
    value
      .trim()
      .replace(/^v/i, '')
      .split(/[^0-9]+/)
      .filter(Boolean)
      .map((part) => Number(part))
  const a = parse(left)
  const b = parse(right)
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export function isNewer(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0
}

/** First enclosure in a Sparkle feed. Returns null when the feed has no item. */
export function readSparkleItem(xml: string): SparkleItem | null {
  const version = /<sparkle:shortVersionString>([^<]+)<\/sparkle:shortVersionString>/.exec(xml)?.[1]?.trim()
  const url = /<enclosure\b[^>]*\burl="([^"]+)"/.exec(xml)?.[1]?.trim()
  if (!version || !url) return null
  return { version, url }
}

export interface UpdateDecision {
  current: string
  latest: string | null
  url: string | null
  updateAvailable: boolean
  note: string
}

export function decideUpdate(current: string, item: SparkleItem | null, emptyNote: string): UpdateDecision {
  if (!item) {
    return { current, latest: null, url: null, updateAvailable: false, note: emptyNote }
  }
  const updateAvailable = isNewer(item.version, current)
  return {
    current,
    latest: item.version,
    url: item.url,
    updateAvailable,
    note: updateAvailable ? `${item.version} is available.` : `${current} is the newest version.`
  }
}

/** Pick a GitHub release. Beta prefers a prerelease; stable ignores them. */
export function pickRelease(releases: readonly ReleaseNote[], channel: 'stable' | 'beta'): ReleaseNote | null {
  if (channel === 'beta') return releases.find((release) => release.prerelease) ?? null
  return releases.find((release) => !release.prerelease) ?? null
}
