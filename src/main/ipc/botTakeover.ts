/**
 * Human takeover of a bot's computer, and the managed VM's own controls.
 *
 * Everything here acts on a target that is already running: the readiness cache
 * a live view depends on, the validation every forwarded click and keystroke
 * passes through, and the restart/terminal channels that reach the same box —
 * which is why they share this module rather than sitting next to the CRUD
 * channels. Both admin channels re-read the bot and its credential themselves;
 * neither trusts anything but the id it was given.
 */

import type {
  ComputerProbeResult,
  HumanComputerAction,
  ScreenControlResult,
  VmAdminResult
} from '../../shared/types'
import { getBot } from '../store/bots'
import { dataRoot } from '../store/paths'
import { vmToken } from '../store/vmSecrets'
import { getComputerProvider, releaseComputerProvidersForBot } from '../tools/computer'
import { restartAppleVm, runAppleVmAdminCommand } from '../vm/appleVmSupervisor'
import { probeTarget } from './botComputerTarget'
import { CHANNELS } from './channels'
import { handle } from './handler'
import { asId, asString } from './validate'

/*
 * Human-view captures arrive every few seconds while a bot is running. Starting
 * and probing the managed VM for every frame is both wasteful and visibly
 * laggy, so remember targets that have passed the full readiness check. A
 * failed screen request invalidates the entry and the next frame performs a
 * fresh start/probe, which also recovers a VM that was stopped out of band.
 */
const readyTakeovers = new Set<string>()

/**
 * Drop a bot's cached readiness. Anything that can change or invalidate the
 * target — an edit, a restart, a deletion — calls this so the next frame pays
 * for a fresh start/probe instead of trusting a check that no longer holds.
 */
export function forgetReadyTakeover(botId: string): void {
  readyTakeovers.delete(botId)
}

function finite(value: unknown, name: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || Math.abs(parsed) > 1_000_000) throw new TypeError(`${name} must be a finite coordinate.`)
  return parsed
}

function asHumanAction(value: unknown): HumanComputerAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('expected a computer action')
  const action = value as Record<string, unknown>
  switch (action['type']) {
    case 'click':
      return {
        type: 'click',
        x: finite(action['x'], 'x'),
        y: finite(action['y'], 'y'),
        button: action['button'] === 'right' || action['button'] === 'middle' ? action['button'] : 'left',
        clickCount: Math.min(3, Math.max(1, Math.round(Number(action['clickCount']) || 1)))
      }
    case 'drag': {
      const from = Array.isArray(action['from']) ? action['from'] : []
      const to = Array.isArray(action['to']) ? action['to'] : []
      if (from.length !== 2 || to.length !== 2) throw new TypeError('a drag needs two coordinate pairs')
      return {
        type: 'drag',
        from: [finite(from[0], 'from x'), finite(from[1], 'from y')],
        to: [finite(to[0], 'to x'), finite(to[1], 'to y')]
      }
    }
    case 'type':
      return { type: 'type', text: asString(action['text'], 100_000) }
    case 'key':
      return { type: 'key', combo: asString(action['combo'], 200) }
    case 'scroll':
      return {
        type: 'scroll',
        x: finite(action['x'], 'x'),
        y: finite(action['y'], 'y'),
        dx: finite(action['dx'], 'dx'),
        dy: finite(action['dy'], 'dy')
      }
    case 'navigate':
      return { type: 'navigate', url: asString(action['url'], 4096) }
    case 'openApp':
      return { type: 'openApp', name: asString(action['name'], 200) }
    default:
      throw new TypeError('unknown computer action')
  }
}

async function takeoverProvider(botId: string) {
  const bot = getBot(botId)
  if (!bot) throw new TypeError(`Unknown bot: ${botId}`)
  if (bot.computerTarget.kind === 'local') {
    throw new TypeError('Human takeover is for a bot browser or private box; this bot already targets your Mac.')
  }
  if (bot.computerTarget.kind === 'vm' && bot.computerTarget.managed === 'apple-vm') {
    if (!readyTakeovers.has(botId)) {
      const probe = await probeTarget(bot.computerTarget, botId)
      if (!probe.ok) throw new Error(probe.detail ?? 'The managed VM did not become ready.')
      readyTakeovers.add(botId)
    }
  }
  return getComputerProvider(bot.computerTarget, { botId, dataDir: dataRoot() })
}

async function withTakeoverProvider<T>(
  botId: string,
  work: (provider: ReturnType<typeof getComputerProvider>) => Promise<T>
): Promise<T> {
  try {
    return await work(await takeoverProvider(botId))
  } catch (error) {
    readyTakeovers.delete(botId)
    throw error
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150))
}

export function registerTakeoverIpc(): void {
  const screenFallback = (_args: unknown[], error: unknown): ScreenControlResult => ({
    ok: false,
    error: error instanceof Error ? error.message : 'The private screen could not be controlled.'
  })

  handle<ScreenControlResult>(CHANNELS.botsCaptureScreen, async ([id]) => {
    const botId = asId(id)
    return withTakeoverProvider(botId, async (provider) => ({
      ok: true,
      frame: await provider.screenshot()
    }))
  }, screenFallback)

  handle<ScreenControlResult>(CHANNELS.botsControlScreen, async ([id, raw]) => {
    const botId = asId(id)
    return withTakeoverProvider(botId, async (provider) => {
      const action = asHumanAction(raw)
      switch (action.type) {
        case 'click':
          await provider.click(action.x, action.y, action.button, action.clickCount)
          break
        case 'drag':
          await provider.drag(action.from, action.to)
          break
        case 'type':
          await provider.typeText(action.text)
          break
        case 'key':
          await provider.keyPress(action.combo)
          break
        case 'scroll':
          await provider.scroll(action.x, action.y, action.dx, action.dy)
          break
        case 'navigate':
          await provider.navigate(action.url)
          break
        case 'openApp':
          await provider.openApp(action.name)
          break
      }
      await settle()
      return { ok: true, frame: await provider.screenshot() }
    })
  }, screenFallback)

  handle<ComputerProbeResult>(CHANNELS.botsRestartTarget, async ([id]) => {
    const botId = asId(id)
    const bot = getBot(botId)
    if (!bot) throw new TypeError(`Unknown bot: ${botId}`)
    if (bot.computerTarget.kind !== 'vm' || bot.computerTarget.managed !== 'apple-vm') {
      throw new TypeError('Only a BlinkyBot-managed VM can be restarted here.')
    }
    const token = vmToken(botId)
    if (!token) throw new Error('The VM credential could not be unlocked from the OS credential store.')
    readyTakeovers.delete(botId)
    await releaseComputerProvidersForBot(botId)
    await restartAppleVm(bot.computerTarget, token)
    return await probeTarget(bot.computerTarget, botId)
  }, (_args, error) => ({
    ok: false,
    detail: error instanceof Error ? error.message : 'The managed VM could not be restarted.'
  }))

  handle<VmAdminResult>(CHANNELS.botsRunAdminCommand, async ([id, rawCommand]) => {
    const botId = asId(id)
    const bot = getBot(botId)
    if (!bot) throw new TypeError(`Unknown bot: ${botId}`)
    if (bot.computerTarget.kind !== 'vm' || bot.computerTarget.managed !== 'apple-vm') {
      throw new TypeError('The administrative terminal is available only for a BlinkyBot-managed VM.')
    }
    const token = vmToken(botId)
    if (!token) throw new Error('The VM credential could not be unlocked from the OS credential store.')
    const result = await runAppleVmAdminCommand(
      bot.computerTarget,
      token,
      asString(rawCommand, 16_384)
    )
    return { ok: true, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode ?? 0 }
  }, (_args, error) => ({
    ok: false,
    error: error instanceof Error ? error.message : 'The VM command could not be run.'
  }))
}
