/**
 * The contracts the loop codes against.
 *
 * Backend and tool shapes are imported from their owning modules rather than
 * redeclared, so a change on either side is a compile error here instead of a
 * silent runtime mismatch. Only the two registries the loop treats as optional
 * (`backends/registry`, `tools/registry`) are described structurally, in
 * `optionalModules.ts`.
 */

import type { Backend, ChatChunk, ChatRequest, ProviderMessage, ProviderPart } from '../backends/types'
import type { Tool, ToolContext, ToolHandler, ToolHost } from '../tools/types'

export type { Backend, ChatChunk, ChatRequest, ProviderMessage, ProviderPart }
export type { Tool, ToolContext, ToolHandler, ToolHost }

/** A tool as the loop uses it: always named, handler guaranteed. */
export interface ToolEntry {
  name: string
  schema?: Tool['schema']
  handler: ToolHandler
}

/** Base64 PNG is how every screenshot travels through this app. */
export const IMAGE_MIME = 'image/png'

/** `mime` defaults to PNG so a computer-use frame stays what it always was. */
export function imagePart(data: string, mime: string = IMAGE_MIME): ProviderPart {
  return { type: 'image', mime: mime || IMAGE_MIME, data }
}

export function textPart(text: string): ProviderPart {
  return { type: 'text', text }
}

/** Plain text of a provider message, whichever form its content takes. */
export function textOf(message: ProviderMessage): string {
  if (typeof message.content === 'string') return message.content
  return message.content
    .filter((part): part is Extract<ProviderPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
}

export function imageCount(message: ProviderMessage): number {
  if (typeof message.content === 'string') return 0
  return message.content.filter((part) => part.type === 'image').length
}
