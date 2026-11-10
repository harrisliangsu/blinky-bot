import type { GmailDraft } from '../../shared/drafts'

export function validMailAddress(value: string): boolean { return value.length <= 254 && /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(value) && !value.includes('..') }

/** Encode non-ASCII subjects as RFC 2047 encoded words without splitting code points. */
function encodedSubject(value: string): string {
  const chunks: string[] = []; let part = ''
  for (const character of value) { if (Buffer.byteLength(part + character) > 36 && part) { chunks.push(part); part = '' } part += character }
  if (part) chunks.push(part)
  return chunks.map((chunk) => `=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`).join('\r\n ')
}
export function gmailMime(draft: Pick<GmailDraft, 'to' | 'subject' | 'body'>): string {
  if (!validMailAddress(draft.to) || /[\r\n\0]/.test(draft.subject)) throw new Error('Invalid mail headers.')
  const content = Buffer.from(draft.body, 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? ''
  return Buffer.from(`To: ${draft.to}\r\nSubject: ${encodedSubject(draft.subject)}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${content}\r\n`).toString('base64url')
}
