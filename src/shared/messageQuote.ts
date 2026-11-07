import type { Attachment } from './chat'

/** Quotes use the existing durable selection attachment channel. */
export const MESSAGE_QUOTE_MIME = 'application/vnd.blinkybot.quote'
export function isMessageQuote(attachment: Attachment): boolean {
  return attachment.kind === 'selection' && attachment.mime === MESSAGE_QUOTE_MIME
}
