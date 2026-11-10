/**
 * App tools: `open_app`, `navigate`.
 *
 * Both name their target explicitly, so the computer-use allowlist is checked
 * against that name rather than against whatever happens to be in front.
 */

import type { ToolSchema } from '../../../shared/types'
import { optStr, reqStr } from '../args'
import { ToolError } from '../errors'
import { defineTool } from '../results'
import { frameResult, withComputerApproval } from './gate'
import { APP_CATALOG } from './browser/apps'

const OPEN_SETTLE_MS = 1500
const NAVIGATE_SETTLE_MS = 2500

export const openAppSchema: ToolSchema = {
  name: 'open_app',
  description:
    'Launch an application and bring it to the front. Use the name as it appears in the Applications ' +
    'folder, e.g. "Safari", "Notes", "Visual Studio Code". Do this before clicking or typing in an app.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Application name.' }
    },
    required: ['name']
  },
  mutating: true,
  computerUse: true
}

export const openAppTool = defineTool(openAppSchema, async (args, ctx) => {
  const name = reqStr(args, 'name', 'open_app').trim()

  const outcome = await withComputerApproval(
    ctx,
    {
      toolName: 'open_app',
      summary: `Open ${name}`,
      detail: `Launch "${name}" and bring it to the front.`,
      targetApp: name,
      settleMs: OPEN_SETTLE_MS
    },
    (provider) => provider.openApp(name, ctx.signal)
  )

  return frameResult(ctx, 'open_app', `Opened ${name}.`, outcome, { app: name })
})

export const navigateSchema: ToolSchema = {
  name: 'navigate',
  description:
    "Open a URL in the default browser. Only http and https are allowed. Follow with a screenshot to " +
    'see the loaded page.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Absolute http(s) URL.' },
      app: { type: 'string', description: 'Open in a specific browser instead of the default one.' }
    },
    required: ['url']
  },
  mutating: true,
  computerUse: true
}

export const navigateTool = defineTool(navigateSchema, async (args, ctx) => {
  const raw = reqStr(args, 'url', 'navigate').trim()
  const app = optStr(args, 'app')
  const url = normalizeUrl(raw)
  const browserTarget = ctx.computerTarget?.kind === 'browser'
  const knownNames = browserTarget ? APP_CATALOG.filter((entry) => new URL(entry.url).hostname === url.hostname).map((entry) => entry.name) : []

  const outcome = await withComputerApproval(
    ctx,
    {
      toolName: 'navigate',
      summary: `Open ${url.host} in ${app ?? 'the default browser'}`,
      detail: `Navigate to:\n${url.toString()}${app ? `\n\nIn: ${app}` : ''}`,
      // For a browser target the action reaches the destination site, not the
      // currently open page or an arbitrary model-supplied app label.
      targetApp: browserTarget ? url.hostname : app,
      targetAliases: knownNames,
      settleMs: NAVIGATE_SETTLE_MS
    },
    async (provider) => {
      if (app && !browserTarget && typeof (provider as { openApp?: unknown }).openApp === 'function') {
        await provider.openApp(app, ctx.signal)
      }
      await provider.navigate(url.toString(), ctx.signal)
    }
  )

  return frameResult(ctx, 'navigate', `Opened ${url.toString()}.`, outcome, { url: url.toString(), app })
})

function normalizeUrl(raw: string): URL {
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new ToolError(`"${raw}" is not a valid URL.`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ToolError(
      `navigate only opens http and https URLs (got "${url.protocol}").`,
      'Use open_app to launch an application, or read_file for local files.'
    )
  }
  return url
}
