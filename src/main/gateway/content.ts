/**
 * `ToolResult` → MCP content blocks.
 *
 * MCP reports tool failure inside the result (`isError: true`) rather than as a
 * JSON-RPC error, so the calling model can read the message and adapt — exactly
 * how our own loop treats `{ ok: false }`. Computer-use tools hand back a base64
 * PNG on `screenshot`, which becomes a second, `image` block so the CLI's model
 * actually sees the screen.
 */

import type { ToolResult } from '../../shared/types'
import { untrustedToolText } from '../agent/untrusted'

/** Beyond this the text is a liability for the client's context, not a help. */
const MAX_TEXT = 200_000

export interface McpTextContent {
  type: 'text'
  text: string
}

export interface McpImageContent {
  type: 'image'
  /** base64, no `data:` prefix. */
  data: string
  mimeType: string
}

export type McpContent = McpTextContent | McpImageContent

export interface McpToolCallResult {
  content: McpContent[]
  isError?: boolean
}

function text(value: string): McpTextContent {
  const trimmed =
    value.length > MAX_TEXT
      ? `${value.slice(0, MAX_TEXT)}\n… truncated, ${value.length - MAX_TEXT} more characters.`
      : value
  return { type: 'text', text: trimmed }
}

/** Accepts a bare base64 payload or a full data URI. */
function imageBlock(screenshot: string): McpImageContent | null {
  const match = /^data:(image\/[a-z.+-]+);base64,(.*)$/is.exec(screenshot.trim())
  const mimeType = match ? match[1] : 'image/png'
  const data = (match ? match[2] : screenshot).replace(/\s+/g, '')
  if (!data) return null
  return { type: 'image', data, mimeType }
}

export function toCallResult(result: ToolResult): McpToolCallResult {
  const output = result.output || (result.ok ? '(no output)' : 'Failed.')
  const truncated = output.length > MAX_TEXT ? `${output.slice(0, MAX_TEXT)}\n… truncated, ${output.length - MAX_TEXT} more characters.` : output
  const content: McpContent[] = [{ type: 'text', text: untrustedToolText(result.name, truncated) }]
  if (result.screenshot) {
    const image = imageBlock(result.screenshot)
    if (image) content.push(image)
  }
  return result.ok ? { content } : { content, isError: true }
}

/** A refusal that never reached a handler: approval denied, tool not granted. */
export function refusal(message: string): McpToolCallResult {
  return { content: [text(message)], isError: true }
}
