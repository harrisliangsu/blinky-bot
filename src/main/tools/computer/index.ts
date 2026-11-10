/**
 * Provider resolution for computer use.
 *
 * A bot drives this Mac, its own browser, or its own VM. All three satisfy
 * `ComputerProvider`, so every tool handler is target-agnostic. Instances are
 * cached per target because providers hold the coordinate space of their last
 * screenshot — and, for a browser, a running Chrome process.
 */

import type { ComputerProvider, ComputerTarget } from '../../../shared/types'
import { browserFor } from './browser/index'
import { BrowserComputerProvider } from './browser/provider'
import { forgetBrowser } from './browser/registry'
import { EgoComputerProvider } from './browser/egoProvider'
import { LocalComputerProvider } from './localProvider'
import { VmComputerProvider } from './vmProvider'
import { vmToken } from '../../store/vmSecrets'
import { browserScopeId } from './browserScope'
import { defaultUserDataDir } from './browser/profile'
import { resolve } from 'node:path'

export { LocalComputerProvider } from './localProvider'
export { VmComputerProvider } from './vmProvider'
export {
  BrowserComputerProvider,
  browserFor,
  getBrowser,
  listBrowsers,
  removeBrowser,
  stopAllBrowsers,
  APP_CATALOG
} from './browser/index'

const providers = new Map<string, { provider: ComputerProvider; owner: string; kind: ComputerTarget['kind'] }>()

export const LOCAL_TARGET: ComputerTarget = { kind: 'local' }

export interface ProviderOptions {
  /**
   * Root for durable per-target state — Electron's `app.getPath('userData')`.
   * A browser's profile lives under it. Derived at runtime when omitted.
   */
  dataDir?: string
  /** Owning bot, used for credentials and targeted lifecycle cleanup. */
  botId?: string
  /** Browser conversation; session-scoped browsers require it. */
  sessionId?: string
}

function keyOf(target: ComputerTarget, botId = '', browserId = '', dataDir = ''): string {
  switch (target.kind) {
    case 'local':
      return 'local'
    case 'browser':
      return JSON.stringify(['browser', target.botId, target.provider ?? 'chrome', browserId, dataDir])
    case 'vm':
      return JSON.stringify(['vm', botId, target.vmId, target.endpoint])
  }
}

/** The provider for a target, created once and reused. Defaults to this Mac. */
export function getComputerProvider(
  target: ComputerTarget = LOCAL_TARGET,
  options: ProviderOptions = {}
): ComputerProvider {
  if (target.kind === 'browser' && options.botId && options.botId !== target.botId) throw new Error('Browser owner does not match the Bot.')
  const dataDir = target.kind === 'browser' ? resolve(options.dataDir ?? defaultUserDataDir()) : options.dataDir
  const browserId = target.kind === 'browser' ? browserScopeId(target.botId, options.sessionId, dataDir).id : ''
  const key = keyOf(target, options.botId, browserId, dataDir)
  const existing = providers.get(key)
  if (existing) return existing.provider

  const created: ComputerProvider =
    target.kind === 'vm'
      ? new VmComputerProvider(target, { token: () => (options.botId ? vmToken(options.botId) : target.token) })
      : target.kind === 'browser'
        ? target.provider === 'ego'
          ? new EgoComputerProvider(browserId, dataDir)
          : browserFor(browserId, { userDataDir: dataDir })
        : new LocalComputerProvider()

  providers.set(key, { provider: created, owner: target.kind === 'browser' ? target.botId : (options.botId ?? ''), kind: target.kind })
  return created
}

/** Drop cached providers (target reconfigured, VM restarted, tests). */
export function resetComputerProviders(): void {
  providers.clear()
}

/** Stop and forget every cached provider owned by one bot. */
export async function releaseComputerProvidersForBot(botId: string): Promise<void> {
  const stopped = new Set<ComputerProvider>()
  for (const [key, record] of [...providers]) {
    if (record.owner !== botId || (record.kind !== 'browser' && record.kind !== 'vm')) continue
    providers.delete(key)
    if (record.provider instanceof BrowserComputerProvider) forgetBrowser(record.provider)
    stopped.add(record.provider)
  }
  for (const provider of stopped) {
    const stop = (provider as ComputerProvider & { stop?: () => Promise<void> }).stop
    if (typeof stop === 'function') await stop.call(provider).catch(() => undefined)
  }
}

/** Human-readable target name for prompts and errors. */
export function describeTarget(target: ComputerTarget = LOCAL_TARGET): string {
  switch (target.kind) {
    case 'local':
      return 'this Mac'
    case 'browser':
      return `this bot's browser`
    case 'vm':
      return `VM ${target.vmId} (${target.endpoint})`
  }
}
