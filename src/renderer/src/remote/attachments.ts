import type { Attachment } from '../../../shared/types'
import { REMOTE_MAX_ATTACHMENTS, REMOTE_MAX_FILE_BYTES } from '../../../shared/remoteAttachments'
import { attachmentsFromImageFiles, isImageFile, type ImageFileLike } from '../components/imageAttachments'

/** Use a real file input in the initiating gesture; Safari must not wait for a network call. */
export function selectBrowserFiles(): Promise<File[]> {
  const input = document.createElement('input')
  input.type = 'file'; input.multiple = true
  input.setAttribute('aria-label', '选择照片或文件 / Choose photos or files')
  input.style.cssText = 'position:fixed;left:-10000px;top:0;opacity:0'
  document.body.append(input)
  return new Promise<File[]>(resolve => {
    let settled = false
    const finish = (files: File[]): void => { if (settled) return; settled = true; input.remove(); resolve(files) }
    input.addEventListener('change', () => finish(Array.from(input.files ?? [])), { once: true })
    input.addEventListener('cancel', () => finish([]), { once: true })
    input.click()
  })
}

export function transferFiles(data: DataTransfer): File[] {
  // Safari may expose clipboard files only through items; prefer one list to avoid duplicates.
  const files = Array.from(data.files ?? [])
  return files.length ? files : Array.from(data.items ?? []).filter(item => item.kind === 'file').flatMap(item => {
    const file = item.getAsFile(); return file ? [file] : []
  })
}

function attachmentId(): string { return 'att-' + Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('') }

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

async function supportedPhoto(file: File): Promise<ImageFileLike> {
  if (isImageFile(file)) return file
  // Safari can decode photos such as HEIC that a model cannot accept directly.
  // Use its decoder when available; never upload an unsupported photo as if it were a usable image.
  const url = URL.createObjectURL(file)
  try {
    const image = new Image(); image.src = url; await image.decode()
    if (!image.naturalWidth || image.naturalWidth * image.naturalHeight > 40_000_000) throw new Error('Photo dimensions exceed the supported limit.')
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
    const context = canvas.getContext('2d'); if (!context) throw new Error('Photo conversion is unavailable.')
    context.drawImage(image, 0, 0)
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Photo conversion failed.')), 'image/jpeg', .92))
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' })
  } catch {
    throw new Error('此照片无法读取，请选择 JPEG、PNG、GIF 或 WebP。 / Choose a JPEG, PNG, GIF or WebP photo.')
  } finally { URL.revokeObjectURL(url) }
}

export async function browserAttachments(files: readonly File[], upload: (input: { name: string; data: string }) => Promise<string>): Promise<Attachment[]> {
  if (files.length > REMOTE_MAX_ATTACHMENTS) throw new Error('一次最多添加 12 个附件。 / Choose up to 12 attachments.')
  const result: Attachment[] = []
  for (const file of files) {
    if (!file.size) throw new Error(`${file.name}：文件为空。 / The file is empty.`)
    if (file.size > REMOTE_MAX_FILE_BYTES) throw new Error(`${file.name}：每个附件最多 6 MB。 / Each attachment must be 6 MB or smaller.`)
    if (isImageFile(file) || file.type.startsWith('image/') && file.type !== 'image/svg+xml') {
      const photo = await supportedPhoto(file)
      const converted = await attachmentsFromImageFiles([photo])
      if (converted.skipped || !converted.attachments.length) throw new Error(`${file.name}：图片过大，请选择较小的图片。 / Choose a smaller image.`)
      for (const attachment of converted.attachments) {
        const path = await upload({ name: attachment.name, data: attachment.data! })
        result.push({ ...attachment, id: attachmentId(), path })
      }
    } else {
      const path = await upload({ name: file.name, data: base64(new Uint8Array(await file.arrayBuffer())) })
      result.push({ id: attachmentId(), kind: 'file', name: file.name, path })
    }
  }
  return result
}
