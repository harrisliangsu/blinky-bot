/**
 * macOS CI captures of the settings sidebar, the bot-first window, and the
 * chat that appears when no CLI is signed in.
 *
 * Set BLINKY_SHOTS=1. A normal launch never enters this path. The runner
 * also strips PATH so a machine image that happens to have a CLI does not
 * turn the empty-backend shot into a real reply.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'

const SECTIONS = [
  'general',
  'bots',
  'profile',
  'notifications',
  'permissions',
  'backends',
  'mcp',
  'updates',
  'about'
] as const

function shotsDir(): string {
  return process.env.BLINKY_SHOTS_DIR || join(process.cwd(), 'shots')
}

/** Isolate data and keep CLI lookup empty before Electron is ready. */
export function prepareShots(): void {
  if (process.env.BLINKY_SHOTS !== '1') return
  const dir = shotsDir()
  mkdirSync(dir, { recursive: true })
  process.env.BLINKY_SHOTS_DIR = dir
  if (!process.env.BLINKY_SMOKE_DIR) {
    const data = join(dir, 'data')
    mkdirSync(data, { recursive: true })
    process.env.BLINKY_SMOKE = '1'
    process.env.BLINKY_SMOKE_DIR = data
    process.env.OPENBOT_DATA_DIR = data
  }
  process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
  app.commandLine.appendSwitch('disable-gpu')
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function evalJs<T>(window: BrowserWindow, source: string): Promise<T> {
  return window.webContents.executeJavaScript(source, true) as Promise<T>
}

async function waitFor(window: BrowserWindow, expression: string, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const found = await evalJs<boolean>(window, `Boolean(${expression})`)
    if (found) return
    await delay(200)
  }
  throw new Error(`timed out waiting for ${expression}`)
}

async function click(window: BrowserWindow, selector: string): Promise<void> {
  const clicked = await evalJs<boolean>(
    window,
    `(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return false; node.click(); return true })()`
  )
  if (!clicked) throw new Error(`could not click ${selector}`)
}

/**
 * The GitHub macOS runner's display is shorter than a settings section.
 * Emulate a taller layout viewport and capture that, instead of the
 * clamped on-screen window.
 */
async function shot(
  window: BrowserWindow,
  name: string,
  width: number,
  height: number,
  clip?: { x: number; y: number; width: number; height: number }
): Promise<void> {
  const dbg = window.webContents.debugger
  if (!dbg.isAttached()) dbg.attach('1.3')
  const frameHeight = Math.ceil(clip ? Math.max(height, clip.y + clip.height) : height)
  await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
    width,
    height: frameHeight,
    deviceScaleFactor: 1,
    mobile: false
  })
  await delay(300)
  const result = (await dbg.sendCommand('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: {
      x: Math.round(clip?.x ?? 0),
      y: Math.round(clip?.y ?? 0),
      width: Math.round(clip?.width ?? width),
      height: Math.round(clip?.height ?? frameHeight),
      scale: 1
    }
  })) as { data: string }
  await writeFile(join(shotsDir(), name), Buffer.from(result.data, 'base64'))
}

async function shotGroup(window: BrowserWindow, name: string, selector: string): Promise<void> {
  const height = await settingsHeight(window)
  const box = await evalJs<{ y: number; height: number } | null>(
    window,
    `(() => {
      const node = document.querySelector(${JSON.stringify(selector)})
      if (!node) return null
      const rect = node.getBoundingClientRect()
      return { y: Math.max(0, rect.y - 12), height: rect.height + 24 }
    })()`
  )
  if (!box) throw new Error(`missing ${selector}`)
  await shot(window, name, 1440, height, {
    x: 0,
    y: box.y,
    width: 1440,
    height: box.height
  })
}

async function settingsHeight(window: BrowserWindow): Promise<number> {
  const height = await evalJs<number>(
    window,
    `(() => {
      const panel = document.querySelector('.ob-set-main')
      const modal = document.querySelector('.ob-modal')
      const body = document.querySelector('.ob-modal-body')
      if (panel) {
        panel.style.maxHeight = 'none'
        panel.style.overflow = 'visible'
      }
      if (body) {
        body.style.overflow = 'visible'
        body.style.maxHeight = 'none'
        body.style.flex = 'none'
      }
      if (modal) {
        modal.style.maxHeight = 'none'
        modal.style.overflow = 'visible'
        modal.style.height = 'auto'
      }
      const needed = modal ? modal.getBoundingClientRect().top + modal.scrollHeight + 24 : 900
      return Math.ceil(Math.min(Math.max(needed, 900), 2800))
    })()`
  )
  return height
}

async function openSettings(window: BrowserWindow): Promise<void> {
  await click(window, '.ob-sidebar [aria-label="Settings (Command comma)"]')
  await waitFor(window, `document.getElementById('ob-set-tab-general')`, 15_000)
}

async function closeSettings(window: BrowserWindow): Promise<void> {
  await click(window, '.ob-modal [aria-label="Close dialog"]')
  await waitFor(window, `!document.querySelector('.ob-modal')`, 10_000)
}

async function chooseTheme(window: BrowserWindow, theme: 'light' | 'dark'): Promise<void> {
  await click(window, `[data-theme-choice="${theme}"]`)
  await waitFor(window, `document.documentElement.getAttribute('data-theme') === ${JSON.stringify(theme)}`, 10_000)
}

/**
 * Backends start with an empty provider card and a CLI card. A key field
 * exists only after the capture path adds that provider and opens 管理.
 * PATH is empty here, so no CLI row is signed in; the CLI card itself is
 * the stable target.
 */
async function waitForBackendCards(window: BrowserWindow): Promise<void> {
  await waitFor(
    window,
    `document.querySelector('[data-add-provider]') && document.querySelector('[data-backend-group="cli"]') && document.querySelector('[data-add-cli]')`,
    15_000
  )
}

async function captureSections(window: BrowserWindow, theme: 'light' | 'dark'): Promise<void> {
  for (const id of SECTIONS) {
    await click(window, `#ob-set-tab-${id}`)
    await waitFor(window, `document.querySelector('[data-settings-section="${id}"]')`, 10_000)
    if (id === 'backends') await waitForBackendCards(window)
    await shot(window, `settings-${theme}-${id}.png`, 1440, await settingsHeight(window))
    if (id === 'backends' && theme === 'light') {
      await waitFor(
        window,
        `document.querySelector('[data-backend-group="provider"] .ob-backend-empty')`,
        10_000
      )
      await shot(window, 'settings-providers-empty-light.png', 1440, await settingsHeight(window))
      await shotGroup(window, 'settings-local-cli-light.png', '[data-backend-group="cli"]')
      await click(window, '[data-add-provider]')
      await waitFor(window, `document.querySelector('[data-provider-choice="openai"]')`, 10_000)
      await click(window, '[data-provider-choice="openai"]')
      await waitFor(window, `document.querySelector('[data-manage-backend="openai"]')`, 10_000)
      await click(window, '[data-manage-backend="openai"]')
      await waitFor(window, `document.getElementById('ob-key-openai')`, 10_000)
      await shot(window, 'settings-providers-added-light.png', 1440, await settingsHeight(window))
    }
  }
}

async function sendAndReadError(window: BrowserWindow): Promise<string> {
  await waitFor(
    window,
    `document.querySelector('#ob-prompt') && !document.querySelector('#ob-prompt').disabled`,
    20_000
  )
  await evalJs(
    window,
    `(() => {
      const el = document.querySelector('#ob-prompt')
      const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
      desc.set.call(el, 'hello')
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`
  )
  await delay(200)
  await click(window, '[aria-label="Send message"]')
  await waitFor(window, `document.querySelector('.ob-msg-error')`, 60_000)
  return evalJs<string>(window, `document.querySelector('.ob-msg-error')?.innerText ?? ''`)
}

export async function captureScreenshots(window: BrowserWindow): Promise<void> {
  const dir = shotsDir()
  try {
    window.setSize(1440, 900)
    await waitFor(window, `document.querySelector('.ob-sidebar')`, 60_000)

    await openSettings(window)
    await chooseTheme(window, 'light')
    await captureSections(window, 'light')
    await closeSettings(window)
    await shot(window, 'main-light.png', 1440, 900)

    await openSettings(window)
    await chooseTheme(window, 'dark')
    await captureSections(window, 'dark')
    await closeSettings(window)
    await shot(window, 'main-dark.png', 1440, 900)

    await openSettings(window)
    await chooseTheme(window, 'light')
    await closeSettings(window)
    await click(window, '.ob-side-list .ob-side-item-main')
    const text = await sendAndReadError(window)
    await shot(window, 'chat-no-backend-light.png', 1440, 900)
    await openSettings(window)
    await chooseTheme(window, 'dark')
    await closeSettings(window)
    await waitFor(window, `document.querySelector('.ob-msg-error')`, 10_000)
    await shot(window, 'chat-no-backend-dark.png', 1440, 900)

    writeFileSync(join(dir, 'chat-no-backend.txt'), `${text}\n`)
    if (!text.includes('Settings → Backends') || text.includes('ENOENT')) {
      throw new Error(`unexpected chat message:\n${text}`)
    }
    writeFileSync(join(dir, 'done'), 'done\n')
    console.log('[blinky-shots] wrote', dir)
    app.exit(0)
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
    writeFileSync(join(dir, 'failed'), message)
    console.error('[blinky-shots] failed', message)
    app.exit(1)
  }
}
