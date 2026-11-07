/** Bounded MIME body extraction. HTML is read as data, never rendered or fetched. */
const MAX_BODY = 50_000
const namedEntities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', bull: '•', copy: '©', reg: '®', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' }
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function header(part: Record<string, unknown>, name: string): string {
  const found = Array.isArray(part.headers) ? part.headers.map(record).find((entry) => typeof entry.name === 'string' && entry.name.toLowerCase() === name) : undefined
  return typeof found?.value === 'string' ? found.value : ''
}
function entities(text: string): string {
  return text.replace(/&(#(?:x[\da-f]+|\d+)|[a-z][\da-z]+);/gi, (source, name: string) => {
    if (!name.startsWith('#')) return Object.hasOwn(namedEntities, name.toLowerCase()) ? namedEntities[name.toLowerCase()] : source
    const value = name[1]?.toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1))
    return Number.isInteger(value) && value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : '�'
  })
}

/** Text projection, not an HTML sanitizer. The result must remain untrusted plain text. */
function htmlText(html: string): string {
  const lower = html.toLowerCase(), out: string[] = []
  let cursor = 0, hidden: string | undefined
  while (cursor < html.length) {
    if (hidden) {
      let close = lower.indexOf(`</${hidden}`, cursor)
      while (close !== -1 && !/[\s/>]/.test(lower[close + hidden.length + 2] ?? '>')) close = lower.indexOf(`</${hidden}`, close + 2)
      if (close === -1) break
      cursor = close; hidden = undefined
    }
    if (html[cursor] !== '<') {
      const next = html.indexOf('<', cursor)
      out.push(html.slice(cursor, next === -1 ? html.length : next)); cursor = next === -1 ? html.length : next; continue
    }
    if (html.startsWith('<!--', cursor)) {
      const end = html.indexOf('-->', cursor + 4); cursor = end === -1 ? html.length : end + 3; continue
    }
    const tag = /^<\/?([a-z][a-z0-9:-]*)\b/i.exec(html.slice(cursor))
    if (!tag && !/^<!|^<\?/.test(html.slice(cursor, cursor + 2))) { out.push('<'); cursor++; continue }
    let end = cursor + 1, quote = ''
    for (; end < html.length; end++) {
      const ch = html[end]
      if (quote) { if (ch === quote) quote = '' }
      else if (ch === '"' || ch === "'") quote = ch
      else if (ch === '>') break
    }
    if (end === html.length) break
    const name = tag?.[1]?.toLowerCase() ?? '', closing = html[cursor + 1] === '/'
    const selfClosingForeign = /^(svg|math)$/.test(name) && /\/\s*$/.test(html.slice(cursor, end))
    if (!closing && !selfClosingForeign && /^(head|script|style|template|noscript|iframe|object|svg|math)$/.test(name)) hidden = name
    if (name === 'br' || /^(p|div|section|article|li|tr|h[1-6]|blockquote|pre|ul|ol)$/.test(name)) out.push('\n')
    else if (name === 'td' || name === 'th') out.push(' ')
    cursor = end + 1
  }
  return entities(out.join('')).replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

function findPart(raw: unknown, mime: string, depth = 0): string | undefined {
  if (depth > 12) return undefined
  const part = record(raw), body = record(part.body)
  if ((typeof part.filename === 'string' && part.filename.trim()) || /^\s*attachment(?:\s*;|\s*$)/i.test(header(part, 'content-disposition')) || part.mimeType === 'message/rfc822') return undefined
  if (part.mimeType === mime && typeof body.data === 'string' && body.data.length < 400_000 && /^[A-Za-z0-9_+\/-]*={0,2}$/.test(body.data)) {
    const charset = /charset\s*=\s*["']?([a-z0-9._:-]+)/i.exec(header(part, 'content-type'))?.[1] ?? 'utf-8'
    try {
      const text = new TextDecoder(charset).decode(Buffer.from(body.data, 'base64url'))
      if (text.trim()) return text
    } catch { /* Unsupported encoding is reported as unavailable, not as a complete empty body. */ }
  }
  if (!Array.isArray(part.parts)) return undefined
  for (const child of part.parts.slice(0, 30)) {
    const value = findPart(child, mime, depth + 1)
    if (value !== undefined) return value
  }
  return undefined
}

export function gmailBody(payload: unknown): { text: string; bodyFormat: 'plain' | 'html-text' | 'unavailable'; bodyTruncated: boolean; note: string } {
  const plain = findPart(payload, 'text/plain'), html = plain === undefined ? findPart(payload, 'text/html') : undefined
  const text = plain ?? (html === undefined ? '' : htmlText(html)), bodyFormat = plain !== undefined ? 'plain' : html !== undefined && text ? 'html-text' : 'unavailable'
  return {
    text: text.slice(0, MAX_BODY), bodyFormat, bodyTruncated: text.length > MAX_BODY,
    note: bodyFormat === 'plain' ? 'First inline plain-text MIME body; attachments excluded.' : bodyFormat === 'html-text' ? 'HTML-only body projected to untrusted plain text; markup, attributes and embedded resources are omitted. Nothing was rendered or fetched.' : 'No readable inline plain-text or HTML body is available within the supported size, encoding and MIME limits. Attachments were not fetched.'
  }
}
