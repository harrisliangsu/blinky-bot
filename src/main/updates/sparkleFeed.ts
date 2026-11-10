/**
 * Compare versions and read a Sparkle appcast without fetching it.
 * The network call lives next to this so the rules can be tested offline.
 */

export interface SparkleItem {
  version: string
  url: string
  /** Ed25519 signature from `sparkle:edSignature`, or null when the item has none. */
  edSignature: string | null
  /** Enclosure length in bytes, or null when the feed omits it. */
  length: number | null
  /** Release notes as plain text, in the language asked for. */
  notes: string
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

export function plainNotes(html: string): string {
  const text = html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h\d|ul|ol|div|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function notesForLanguage(itemXml: string, language: 'en' | 'zh-CN'): string {
  const descriptions: Array<{ lang: string; html: string }> = []
  for (const match of itemXml.matchAll(/<description\b([^>]*)>([\s\S]*?)<\/description>/gi)) {
    const lang = /xml:lang="([^"]+)"/i.exec(match[1] ?? '')?.[1]?.trim() ?? ''
    let body = (match[2] ?? '').trim()
    const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(body)
    if (cdata) body = cdata[1] ?? ''
    descriptions.push({ lang, html: body })
  }
  const want = language === 'zh-CN' ? /^zh/i : /^en/i
  const match = descriptions.find((item) => want.test(item.lang)) ?? descriptions.find((item) => item.lang === '') ?? descriptions[0]
  return plainNotes(match?.html ?? '')
}

/** First enclosure in a Sparkle feed. Returns null when the feed has no item. */
export function readSparkleItem(xml: string, language: 'en' | 'zh-CN' = 'en'): SparkleItem | null {
  const itemXml = /<item\b[^>]*>([\s\S]*?)<\/item>/.exec(xml)?.[1] ?? ''
  if (!itemXml) return null
  const version = /<sparkle:shortVersionString>([^<]+)<\/sparkle:shortVersionString>/.exec(itemXml)?.[1]?.trim()
  const attrs = /<enclosure\b([^>]*)\/?>/.exec(itemXml)?.[1] ?? ''
  const url = /\burl="([^"]+)"/.exec(attrs)?.[1]?.trim().replace(/&amp;/g, '&')
  if (!version || !url) return null
  const signature = /\bsparkle:edSignature="([^"]*)"/.exec(attrs)?.[1]?.trim() ?? ''
  const lengthText = /\blength="([^"]*)"/.exec(attrs)?.[1]?.trim() ?? ''
  const length = /^[0-9]+$/.test(lengthText) ? Number(lengthText) : Number.NaN
  return {
    version,
    url,
    edSignature: signature || null,
    length: Number.isSafeInteger(length) ? length : null,
    notes: notesForLanguage(itemXml, language)
  }
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
