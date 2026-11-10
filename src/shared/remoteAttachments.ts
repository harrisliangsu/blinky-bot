/** One contract for the browser picker, pasted images and the signed upload endpoint. */
export const REMOTE_MAX_FILE_BYTES = 6 * 1024 * 1024
export const REMOTE_MAX_ATTACHMENTS = 12
export const REMOTE_MAX_REQUEST_BYTES = 12 * 1024 * 1024

/** Flat character validation avoids a repeated-group RegExp overflowing on multi-MB files. */
export function validRemoteBase64(data: string): boolean {
  if (!data.length || data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(data)) return false
  const padding = data.indexOf('=')
  return padding < 0 || (padding >= data.length - 2 && /^={1,2}$/.test(data.slice(padding)))
}
