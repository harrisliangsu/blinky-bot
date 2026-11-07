/**
 * The per-bot browser registry.
 *
 * One Chrome process per bot, created lazily and kept for the life of the
 * process so a bot's profile — and therefore its sign-ins — survives between
 * turns. Creating a provider does not start Chrome; the session does that on
 * first use.
 */

import { ToolError } from '../../errors'
import { DEFAULT_SPEC, type BrowserSpec } from './chrome'
import { BrowserComputerProvider } from './provider'
import { defaultUserDataDir, deleteProfile } from './profile'
import { resolve } from 'node:path'

const browsers = new Map<string, BrowserComputerProvider>()
const browserKey = (botId: string, userDataDir?: string): string => JSON.stringify([resolve(userDataDir ?? defaultUserDataDir()), botId])

/** Get or create a bot's browser. Does not start it. */
export function browserFor(
  botId: string,
  options: { userDataDir?: string; spec?: Partial<BrowserSpec> } = {}
): BrowserComputerProvider {
  const key = browserKey(botId, options.userDataDir)
  const existing = browsers.get(key)
  if (existing) return existing
  if (!botId.trim()) throw new ToolError('A browser target needs a bot id.')
  const created = new BrowserComputerProvider(
    { botId, ...DEFAULT_SPEC, ...options.spec },
    options.userDataDir
  )
  browsers.set(key, created)
  return created
}

export function getBrowser(botId: string, userDataDir?: string): BrowserComputerProvider | undefined {
  return browsers.get(browserKey(botId, userDataDir))
}

export function listBrowsers(): BrowserComputerProvider[] {
  return [...browsers.values()]
}

/** Forget exactly the released provider without touching any browser profile. */
export function forgetBrowser(provider: BrowserComputerProvider): void {
  for (const [key, candidate] of browsers) if (candidate === provider) browsers.delete(key)
}

/** Stop and forget one browser, optionally removing its persistent profile. */
export async function removeBrowser(
  botId: string,
  options: { userDataDir?: string; deleteProfile?: boolean } = {}
): Promise<void> {
  const key = browserKey(botId, options.userDataDir)
  const browser = browsers.get(key)
  if (browser) {
    try { await browser.stop() } catch (error) { if (options.deleteProfile) throw error }
    browsers.delete(key)
  }
  if (options.deleteProfile) await deleteProfile(botId, options.userDataDir)
}

/** Shut every browser down — call on app quit so no Chrome is orphaned. */
export async function stopAllBrowsers(): Promise<void> {
  await Promise.all([...browsers.values()].map((b) => b.stop().catch(() => undefined)))
  browsers.clear()
}
