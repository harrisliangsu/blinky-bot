/**
 * Images that have to reach a local CLI, not stop as a text footnote.
 *
 * History already turns a pasted attachment into provider image parts when the
 * model can see. Text-only CLIs still say those parts were omitted. Codex and
 * Claude Code can take the bytes: Codex as a `localImage` on `turn/start`,
 * Claude Code as a stream-json content block. Both want the same slice of the
 * turn — every image on a cold prompt, only the newest user turn once the
 * CLI already holds the thread.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { imagePartsOf, safeImageMime } from '../messageContent'
import type { ProviderImagePart, ProviderMessage } from '../types'

/** Enough for a few screenshots; a pasted folder must not become the prompt. */
export const MAX_TURN_IMAGES = 6

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
}

/** Raw base64, bounded. A sliced or decorated string is not an image. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
const MAX_DATA_CHARS = 8 * 1024 * 1024
const MAX_DECODED_BYTES = 6 * 1024 * 1024

export interface CodexTurnItem {
  type: 'text' | 'localImage'
  text?: string
  path?: string
}

interface DecodedImage {
  mime: string
  data: string
  bytes: Buffer
}

/**
 * Codex and Claude Code both accept images. A catalog that has not loaded yet
 * must not replace the paste with "this model cannot see images" — that string
 * is all the CLI would ever receive. A model row that explicitly cannot see
 * still wins.
 */
export function backendSeesImages(
  backendId: string,
  model: { supportsVision?: boolean } | null
): boolean {
  if (model) return model.supportsVision === true
  return backendId === 'codex' || backendId === 'claude'
}

/**
 * Images that belong on this CLI turn.
 *
 * `latestUserOnly` matches a warm thread: earlier images were sent with the
 * turn that carried them. A cold prompt sends the images the flattened text
 * is about to mention, newest last, and drops the oldest past the cap.
 */
export function turnImages(messages: readonly ProviderMessage[], latestUserOnly: boolean): ProviderImagePart[] {
  if (latestUserOnly) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== 'user') continue
      return imagePartsOf(messages[i].content).slice(0, MAX_TURN_IMAGES)
    }
    return []
  }
  const out: ProviderImagePart[] = []
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'tool') continue
    out.push(...imagePartsOf(message.content))
  }
  return out.slice(-MAX_TURN_IMAGES)
}

function decodeImage(part: ProviderImagePart): DecodedImage | null {
  const data = part.data.replace(/\s+/g, '')
  if (!data || data.length > MAX_DATA_CHARS || data.length % 4 !== 0 || !BASE64.test(data)) return null
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length === 0 || bytes.length > MAX_DECODED_BYTES) return null
  return { mime: safeImageMime(part.mime), data, bytes }
}

/**
 * `turn/start` input. The text item is what the thread already expects; each
 * image is a local file the app-server reads itself. Remote URLs are rejected
 * by Codex, so the path has to be one we just wrote.
 */
export function codexTurnItems(text: string, paths: readonly string[]): CodexTurnItem[] {
  const items: CodexTurnItem[] = [{ type: 'text', text }]
  for (const path of paths) {
    if (!path) continue
    items.push({ type: 'localImage', path })
  }
  return items
}

/**
 * Write image parts where the Codex app-server can open them.
 *
 * The directory is mode-restricted by the temp parent and each file is
 * `0600`. `cleanup` removes the directory after the turn — Codex reads the
 * files while the turn is running, so the caller deletes them only once the
 * turn has finished or failed.
 */
export async function materializeCodexImages(
  parts: readonly ProviderImagePart[]
): Promise<{ paths: string[]; cleanup: () => Promise<void> }> {
  const ready = parts.map(decodeImage).filter((image): image is DecodedImage => image !== null)
  if (ready.length === 0) return { paths: [], cleanup: async () => undefined }

  const dir = await mkdtemp(join(tmpdir(), 'blinky-codex-'))
  const paths: string[] = []
  try {
    for (let i = 0; i < ready.length; i++) {
      const ext = EXT_BY_MIME[ready[i].mime] ?? 'png'
      const path = join(dir, `image-${i}.${ext}`)
      await writeFile(path, ready[i].bytes, { mode: 0o600 })
      paths.push(path)
    }
  } catch (err) {
    await rm(dir, { recursive: true, force: true })
    throw err
  }
  return {
    paths,
    cleanup: () => rm(dir, { recursive: true, force: true })
  }
}

/**
 * One Claude Code stream-json user message, or null when nothing visual survived.
 *
 * Print mode reads this from stdin once `--input-format stream-json` is set.
 * The image block is the same base64 shape the Anthropic API accepts, which
 * is what Claude Code forwards. Invalid bytes are dropped rather than sent
 * as a broken block that fails the whole turn.
 */
export function claudeStreamInput(text: string, images: readonly ProviderImagePart[]): string | null {
  const content: Array<Record<string, unknown>> = []
  if (text.trim()) content.push({ type: 'text', text })
  for (const image of images) {
    const decoded = decodeImage(image)
    if (!decoded) continue
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: decoded.mime, data: decoded.data }
    })
  }
  if (!content.some((block) => block['type'] === 'image')) return null
  return JSON.stringify({ type: 'user', message: { role: 'user', content } })
}
