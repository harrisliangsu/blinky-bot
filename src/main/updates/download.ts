/**
 * The zip named by the appcast is the only file an install may download.
 * GitHub redirects that URL onto `githubusercontent.com`; other hosts are refused
 * before any byte is kept. The signature check still has to pass afterwards.
 *
 * Redirects are followed by hand. `fetch` with `redirect: 'manual'` hides the
 * next URL, so it cannot enforce the host list.
 */

import { request as httpsRequest } from 'node:https'
import { createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** Larger than the published zip, smaller than a feed that could fill the disk. */
export const MAX_ARCHIVE_BYTES = 800 * 1024 * 1024

export interface ArchiveResponse {
  status: number
  header(name: string): string | null
  body: Readable | null
  cancel(): void
}

export function isBlinkyReleaseArchive(value: string): boolean {
  return releasePath(value, /^\/harrisliangsu\/blinky-bot\/releases\/download\/[^/]+\/[^/]+\.zip$/i)
}

export function isBlinkyReleasePage(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (!isPublicHttps(url) || !isGitHubHost(url.hostname)) return false
  return (
    /^\/harrisliangsu\/blinky-bot\/releases\/tag\/[^/]+$/.test(url.pathname) ||
    url.pathname === '/harrisliangsu/blinky-bot/releases' ||
    url.pathname === '/harrisliangsu/blinky-bot/releases/latest'
  )
}

/** A redirect target. The first URL still has to be the release zip. */
export function isAllowedDownloadUrl(value: string): boolean {
  if (isBlinkyReleaseArchive(value)) return true
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (!isPublicHttps(url)) return false
  return url.hostname.endsWith('.githubusercontent.com') && !url.hostname.includes('..')
}

function isGitHubHost(hostname: string): boolean {
  return hostname === 'github.com' || hostname === 'www.github.com'
}

function isPublicHttps(url: URL): boolean {
  return url.protocol === 'https:' && url.username === '' && url.password === ''
}

function releasePath(value: string, path: RegExp): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return isPublicHttps(url) && isGitHubHost(url.hostname) && path.test(url.pathname)
}

export async function downloadReleaseArchive(
  url: string,
  dest: string,
  maxBytes: number,
  request: (url: string) => Promise<ArchiveResponse> = requestArchive
): Promise<number> {
  if (!isBlinkyReleaseArchive(url)) throw new Error('The update address is not a BlinkyBot release.')
  let current = url
  for (let hop = 0; hop <= 5; hop += 1) {
    const response = await request(current)
    if (response.status >= 300 && response.status < 400) {
      const location = response.header('location')
      response.cancel()
      if (!location || hop === 5) throw new Error('The update download was redirected to an unexpected host.')
      const next = new URL(location, current).toString()
      if (!isAllowedDownloadUrl(next)) throw new Error('The update download was redirected to an unexpected host.')
      current = next
      continue
    }
    if (response.status < 200 || response.status >= 300) {
      response.cancel()
      throw new Error(`HTTP ${response.status}`)
    }
    const declared = Number(response.header('content-length') ?? '')
    if (Number.isFinite(declared) && declared > maxBytes) {
      response.cancel()
      throw new Error('The update is larger than expected.')
    }
    try {
      return await writeBody(response.body, dest, maxBytes)
    } catch (error) {
      response.cancel()
      await rm(dest, { force: true }).catch(() => undefined)
      throw error
    }
  }
  throw new Error('The update download was redirected to an unexpected host.')
}

function requestArchive(url: string): Promise<ArchiveResponse> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      { method: 'GET', headers: { Accept: 'application/octet-stream', 'User-Agent': 'BlinkyBot' }, timeout: 120_000 },
      (message: IncomingMessage) => {
        resolve({
          status: message.statusCode ?? 0,
          header: (name) => {
            const value = message.headers[name.toLowerCase()]
            return Array.isArray(value) ? value[0] ?? null : value ?? null
          },
          body: message,
          cancel: () => message.destroy()
        })
      }
    )
    req.once('error', reject)
    req.once('timeout', () => req.destroy(new Error('The update download timed out.')))
    req.end()
  })
}

async function writeBody(body: Readable | null, dest: string, maxBytes: number): Promise<number> {
  if (!body) throw new Error('The update download was empty.')
  let received = 0
  const limit = new Transform({
    transform(chunk: Buffer | string, _encoding, callback) {
      const size = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
      received += size
      if (received > maxBytes) callback(new Error('The update is larger than expected.'))
      else callback(null, chunk)
    }
  })
  await pipeline(body, limit, createWriteStream(dest))
  return received
}
