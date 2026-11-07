import { PROFILE_IMAGE_SIZE, profileImageSource } from '../../../shared/userProfile'
import { attachmentsFromImageFiles, imagePreviewSrc, isImageFile } from './imageAttachments'

/** Reuse attachment MIME checks, but persist only a cropped raster thumbnail. */
export async function readProfileImage(file: File): Promise<string> {
  if (!isImageFile(file) || !file.size || file.size > 5 * 1024 * 1024) throw new Error('Invalid image')
  const { attachments } = await attachmentsFromImageFiles([file])
  const src = attachments[0] && imagePreviewSrc(attachments[0])
  if (!src) throw new Error('Unreadable image')
  const image = new Image()
  image.src = src
  await image.decode()
  if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth > 4096 || image.naturalHeight > 4096) throw new Error('Image too large')
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = PROFILE_IMAGE_SIZE
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Image unavailable')
  const side = Math.min(image.naturalWidth, image.naturalHeight)
  context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, canvas.width, canvas.height)
  const output = canvas.toDataURL('image/png')
  if (!profileImageSource(output)) throw new Error('Image unavailable')
  return output
}
