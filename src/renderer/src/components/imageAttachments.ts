/**
 * Images dropped or pasted into the composer.
 *
 * The bytes travel with the message. A path alone would let the chip render
 * and then leave the CLI with nothing to open. Only the image types the
 * backends actually forward are accepted; anything else stays a normal paste.
 */

import type { Attachment } from '../../../shared/types'

/** Under the IPC cap, so the main process does not slice the base64 in half. */
export const MAX_IMAGE_DATA_LENGTH = 7_500_000

const PREVIEW_MIME = /^image\/(png|jpeg|gif|webp)$/
const PREVIEW_DATA = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * A data URL safe to put on an `<img>`. SVG and other types stay off the
 * transcript: a data URL of those can carry script. Anything that is not
 * plain base64 is not rendered either.
 */
export function imagePreviewSrc(attachment: { kind: string; mime?: string; data?: string }): string | null {
  if (attachment.kind !== 'image' || !attachment.mime || !attachment.data) return null
  if (!PREVIEW_MIME.test(attachment.mime)) return null
  const data = attachment.data.replace(/\s+/g, '')
  if (!data || data.length > MAX_IMAGE_DATA_LENGTH || data.length % 4 !== 0 || !PREVIEW_DATA.test(data)) return null
  return `data:${attachment.mime};base64,${data}`
}

const IMAGE_MIME = /^image\/(png|jpeg|gif|webp)$/
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i

export interface ImageFileLike {
  name: string
  type: string
  size: number
  lastModified?: number
  arrayBuffer: () => Promise<ArrayBuffer>
}

export function isImageFile(file: { type: string; name: string }): boolean {
  return IMAGE_MIME.test(normalizedType(file.type)) || IMAGE_EXT.test(file.name)
}

function normalizedType(type: string): string {
  return type === 'image/jpg' ? 'image/jpeg' : type
}

export function mimeForImage(file: { type: string; name: string }): string {
  const type = normalizedType(file.type)
  if (IMAGE_MIME.test(type)) return type
  const ext = (file.name.split('.').pop() ?? '').toLowerCase()
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  return 'image/png'
}

function extensionFor(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg'
  const subtype = mime.split('/')[1]
  return subtype || 'png'
}

/** Clipboard and drop events expose the same files in two different lists. */
export function filesFromTransfer(data: {
  files?: ArrayLike<ImageFileLike>
  items?: ArrayLike<{ kind: string; type: string; getAsFile?: () => ImageFileLike | null }>
}): ImageFileLike[] {
  // Chromium may create different File wrappers (and timestamps or names) for
  // the same clipboard image in `files` and `items`. Use a single source;
  // comparing metadata across both lists is not a reliable identity check.
  const files = data.files ? Array.from(data.files).filter(isImageFile) : []
  if (files.length) return files
  const out: ImageFileLike[] = []
  if (data.items) {
    for (const item of Array.from(data.items)) {
      if (item.kind !== 'file' || !item.type.toLowerCase().startsWith('image/')) continue
      const file = item.getAsFile?.()
      if (file && isImageFile(file)) out.push(file)
    }
  }
  return out
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/**
 * Turn image files into attachments. Oversized files are counted in
 * `skipped` and left out — a truncated base64 string is not an image the
 * model can open.
 */
export async function attachmentsFromImageFiles(
  files: readonly ImageFileLike[],
  opts?: { maxDataLength?: number; now?: number }
): Promise<{ attachments: Attachment[]; skipped: number }> {
  const max = opts?.maxDataLength ?? MAX_IMAGE_DATA_LENGTH
  const now = opts?.now ?? Date.now()
  const attachments: Attachment[] = []
  let skipped = 0
  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    if (!isImageFile(file)) continue
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (bytes.byteLength === 0) continue
    const data = bytesToBase64(bytes)
    if (data.length > max) {
      skipped += 1
      continue
    }
    const mime = mimeForImage(file)
    attachments.push({
      id: `att-${now}-${i}`,
      kind: 'image',
      name: file.name.trim() || `pasted-image.${extensionFor(mime)}`,
      mime,
      data
    })
  }
  return { attachments, skipped }
}
