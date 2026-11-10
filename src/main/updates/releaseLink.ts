/** Open a BlinkyBot GitHub page. The updater and Settings share this allow-list. */

import { shell } from 'electron'

const RELEASE_HOSTS = new Set(['github.com', 'www.github.com'])

export async function openBlinkyRelease(value: string): Promise<boolean> {
  if (typeof value !== 'string') return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || !RELEASE_HOSTS.has(url.hostname)) return false
  if (!url.pathname.startsWith('/harrisliangsu/blinky-bot')) return false
  await shell.openExternal(url.toString())
  return true
}
