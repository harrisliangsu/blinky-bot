import { createRequire } from 'node:module'
import { profileImageSource } from '../shared/userProfile'

/** Re-encode raster bytes; no remote URL, path, SVG or source metadata persists. */
export function canonicalProfileImage(value: unknown): string {
  if (value === '') return ''
  const source = profileImageSource(value)
  if (!source) throw new Error('Invalid profile image')
  const { nativeImage } = createRequire(import.meta.url)('electron') as typeof import('electron')
  const image = nativeImage.createFromDataURL(source)
  if (image.isEmpty()) throw new Error('Unreadable profile image')
  const output = `data:image/png;base64,${image.toPNG().toString('base64')}`
  if (!profileImageSource(output)) throw new Error('Invalid profile image size')
  return output
}
