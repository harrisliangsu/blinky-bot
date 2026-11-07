/** User-owned local identity, independent of every Bot's avatar. */
export const PROFILE_IMAGE_SIZE = 256
export const MAX_PROFILE_IMAGE_LENGTH = 400_000

/** Only a small raster PNG may enter an image src or the settings document. */
export function profileImageSource(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_PROFILE_IMAGE_LENGTH || !value.startsWith('data:image/png;base64,')) return null
  const data = value.slice(22)
  if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null
  try {
    const header = atob(data.slice(0, 32))
    if (!header.startsWith('\x89PNG\r\n\x1a\n') || header.slice(12, 16) !== 'IHDR') return null
    const size = (offset: number): number => [0, 1, 2, 3].reduce((n, i) => n * 256 + header.charCodeAt(offset + i), 0)
    const width = size(16), height = size(20)
    return width > 0 && height > 0 && width <= PROFILE_IMAGE_SIZE && height <= PROFILE_IMAGE_SIZE ? value : null
  } catch { return null }
}
