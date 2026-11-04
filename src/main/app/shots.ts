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

async function save(window: BrowserWindow, name: string): Promise<void> {
  await delay(350)
  const image = await window.webContents.capturePage()
  await writeFile(join(shotsDir(), name), image.toPNG())
}

/** Let a settings section grow to its content so the shot is not a clipped card. */
async function fitSettings(window: BrowserWindow): Promise<void> {
  const height = await evalJs<number>(
    window,
    `(() => {
      const panel = document.querySelector('.ob-set-main')
      const modal = document.querySelector('.ob-modal')
      const scrim = document.querySelector('.ob-modal-scrim')
      if (panel) panel.style.maxHeight = 'none'
      if (modal) {
        modal.style.maxHeight = 'none'
        modal.style.overflow = 'visible'
      }
      if (scrim) {
        scrim.style.alignItems = 'flex-start'
        scrim.style.overflow = 'visible'
        scrim.style.height = 'auto'
      }
      const needed = modal ? modal.getBoundingClientRect().top + modal.scrollHeight + 32 : 900
      return Math.ceil(needed)
    })()`
  )
  window.setSize(1440, Math.min(Math.max(height, 900), 2800))
  await delay(250)
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

async function captureSections(window: BrowserWindow, theme: 'light' | 'dark'): Promise<void> {
  for (const id of SECTIONS) {
    await click(window, `#ob-set-tab-${id}`)
    await waitFor(window, `document.querySelector('[data-settings-section="${id}"]')`, 10_000)
    await fitSettings(window)
    await save(window, `settings-${theme}-${id}.png`)
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
    window.setSize(1440, 900)
    await save(window, 'main-light.png')

    await openSettings(window)
    await chooseTheme(window, 'dark')
    await captureSections(window, 'dark')
    await closeSettings(window)
    window.setSize(1440, 900)
    await save(window, 'main-dark.png')

    await openSettings(window)
    await chooseTheme(window, 'light')
    await closeSettings(window)
    window.setSize(1440, 900)
    await click(window, '.ob-side-list .ob-side-item-main')
    const text = await sendAndReadError(window)
    await save(window, 'chat-no-backend-light.png')
    await openSettings(window)
    await chooseTheme(window, 'dark')
    await closeSettings(window)
    window.setSize(1440, 900)
    await waitFor(window, `document.querySelector('.ob-msg-error')`, 10_000)
    await save(window, 'chat-no-backend-dark.png')

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
