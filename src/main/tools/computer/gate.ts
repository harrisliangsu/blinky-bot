/**
 * The computer-use gate shared by every computer tool.
 *
 * Order of business, identical for the local Mac and for a bot VM:
 *   1. resolve the provider from the bot's computer target,
 *   2. check the action's app against `settings.computerUseAllowedApps`,
 *   3. capture a preview frame and get explicit approval (`kind: 'computer'`),
 *   4. perform the action,
 *   5. capture the resulting frame, publish it, and hand it back.
 *
 * No host-specific logic lives here — only the provider interface is used.
 */

import type { ComputerProvider, ScreenFrame, ToolResult } from '../../../shared/types'
import { requireApproval } from '../approval'
import { raceAbort, throwIfAborted } from '../cancel'
import { ToolError } from '../errors'
import { emitFrame } from '../events'
import { matchesPattern, settingsOf } from '../settings'
import type { ToolContext } from '../types'
import { describeTarget, getComputerProvider, LOCAL_TARGET } from './index'
import { APP_CATALOG } from './browser/apps'

/** A provider that can name the app currently in front (the local Mac can). */
interface AppAware {
  activeApp(signal?: AbortSignal): Promise<string | undefined>
}

/** Reusing a very recent frame avoids a second capture per action. */
const PREVIEW_REUSE_MS = 1500
const frameCache = new WeakMap<ComputerProvider, { frame: ScreenFrame; at: number }>()

export interface ComputerActionOptions {
  toolName: string
  /** One line for the approval prompt. */
  summary: string
  /** Full description shown under the preview. */
  detail: string
  /** App this action targets. Omitted means "whatever is in front". */
  targetApp?: string
  /** Equivalent verified names for the same destination, e.g. a known web-app hostname. */
  targetAliases?: string[]
  /** Milliseconds to wait for the UI to settle before the result frame. */
  settleMs?: number
  /** For `screenshot`: the preview frame is the result, so do not recapture. */
  reusePreviewAsResult?: boolean
}

export interface ComputerActionResult<T> {
  value: T
  /** Frame captured after the action (or the preview, for `screenshot`). */
  frame: ScreenFrame
  target: string
}

/** Vault actions authorize the current destination without publishing form images. */
export async function withComputerAuthorization<T>(ctx: ToolContext, options: ComputerActionOptions, run: (provider: ComputerProvider) => Promise<T>): Promise<T> {
  throwIfAborted(ctx, options.toolName)
  if (ctx.computerTarget?.kind !== 'browser') throw new ToolError('Vault references can only fill a Bot browser.')
  const provider = getComputerProvider(ctx.computerTarget, { dataDir: ctx.dataDir, botId: ctx.botId, sessionId: ctx.sessionId })
  await assertAppAllowed(ctx, provider, options)
  await requireApproval(ctx, { toolName: options.toolName, kind: 'computer', summary: options.summary, detail: options.detail }, { force: true })
  await assertAppAllowed(ctx, provider, options)
  throwIfAborted(ctx, options.toolName)
  frameCache.delete(provider)
  try { return await raceAbort(run(provider), ctx.signal, options.toolName) }
  finally { frameCache.delete(provider) }
}

export async function withComputerApproval<T>(
  ctx: ToolContext,
  options: ComputerActionOptions,
  run: (provider: ComputerProvider) => Promise<T>
): Promise<ComputerActionResult<T>> {
  throwIfAborted(ctx, options.toolName)
  const target = ctx.computerTarget ?? LOCAL_TARGET
  const provider = getComputerProvider(target, { dataDir: ctx.dataDir, botId: ctx.botId, sessionId: ctx.sessionId })
  const targetLabel = describeTarget(target)

  await assertAppAllowed(ctx, provider, options)

  // A destination check does not authorize the page currently displayed. For
  // navigation from a blank or ungranted page, ask without a preview instead.
  // Do not reuse a browser frame from another page or an earlier allowlist.
  let preview: ScreenFrame | undefined
  if (target.kind === 'browser') {
    const currentOptions = { ...options, targetApp: undefined, targetAliases: [] }
    let currentAllowed = false
    try {
      await assertAppAllowed(ctx, provider, currentOptions)
      currentAllowed = true
    } catch { /* unknown or ungranted current page: no preview */ }
    throwIfAborted(ctx, options.toolName)
    if (currentAllowed) {
      frameCache.delete(provider)
      const captured = await raceAbort(captureFrame(provider, ctx.signal), ctx.signal, options.toolName)
      // A redirect during capture must not turn an old authorization into a
      // preview of a new, ungranted page.
      try {
        await assertAppAllowed(ctx, provider, currentOptions)
        preview = captured
      } catch { frameCache.delete(provider) }
    }
  } else {
    preview = await raceAbort(captureFrame(provider, ctx.signal), ctx.signal, options.toolName)
  }

  await requireApproval(
    ctx,
    {
      toolName: options.toolName,
      kind: 'computer',
      summary: `${options.summary} · ${targetLabel}`,
      detail: [
        options.detail,
        '',
        `Target:    ${targetLabel}`,
        ...(preview ? [`Frame:     ${preview.width}×${preview.height} px (scale ${preview.scale.toFixed(2)})`] : [])
      ].join('\n'),
      ...(preview ? { preview: preview.image } : {})
    },
    { force: true }
  )

  // The user may spend an arbitrary time deciding. A click/key must not use
  // the authorization of the page that happened to be visible before that wait.
  if (target.kind === 'browser') await assertAppAllowed(ctx, provider, options)
  throwIfAborted(ctx, options.toolName)
  const value = await raceAbort(run(provider), ctx.signal, options.toolName)

  if (options.settleMs && options.settleMs > 0) {
    await raceAbort(delay(options.settleMs), ctx.signal, options.toolName)
  }
  // Recheck after settling because any browser action can navigate. This is a
  // screenshot boundary, not a network-request or redirect interception.
  const currentOptions = { ...options, targetApp: undefined, targetAliases: [] }
  if (target.kind === 'browser') await assertAppAllowed(ctx, provider, currentOptions)
  let frame: ScreenFrame
  if (options.reusePreviewAsResult && preview) {
    frame = preview
  } else {
    frameCache.delete(provider)
    frame = await raceAbort(captureFrame(provider, ctx.signal), ctx.signal, options.toolName)
  }
  if (target.kind === 'browser') await assertAppAllowed(ctx, provider, currentOptions)
  emitFrame(ctx, frame.image)
  return { value, frame, target: targetLabel }
}

/**
 * Shape a completed action into a `ToolResult`: the outcome message, the frame
 * the model should reason over, and the pixel space that frame is in.
 */
export function frameResult<T>(
  ctx: ToolContext,
  toolName: string,
  message: string,
  outcome: ComputerActionResult<T>,
  detail: Record<string, unknown> = {}
): ToolResult {
  const { frame } = outcome
  return {
    callId: ctx.callId ?? '',
    name: toolName,
    ok: true,
    output:
      `${message}\n` +
      `Screen after the action: ${frame.width}×${frame.height} px on ${outcome.target}. ` +
      'Give coordinates for click, scroll and drag in that pixel space, origin top-left.',
    screenshot: frame.image,
    detail: { ...detail, target: outcome.target, width: frame.width, height: frame.height, scale: frame.scale }
  }
}

/** Capture, reusing a frame taken moments ago. */
export async function captureFrame(provider: ComputerProvider, signal?: AbortSignal): Promise<ScreenFrame> {
  const cached = frameCache.get(provider)
  if (cached && Date.now() - cached.at < PREVIEW_REUSE_MS) return cached.frame
  const frame = await provider.screenshot(signal)
  frameCache.set(provider, { frame, at: Date.now() })
  return frame
}

/** Force the next capture to be fresh (used after an action changes the screen). */
export function invalidateFrame(provider: ComputerProvider): void {
  frameCache.delete(provider)
}

/**
 * Computer use is only permitted for apps the user has granted. An empty list
 * means nothing has been granted yet, and `*` means everything.
 */
async function assertAppAllowed(
  ctx: ToolContext,
  provider: ComputerProvider,
  options: ComputerActionOptions
): Promise<void> {
  const allowed = settingsOf(ctx).computerUseAllowedApps
  if (allowed.length === 0) {
    throw new ToolError(
      'Computer use is not enabled for any app yet, so this action was not attempted.',
      'Ask the user to open Settings → Computer use and add the apps this bot may drive (or "*" for all of them).'
    )
  }
  if (allowed.some((entry) => entry.trim() === '*')) return

  const app = options.targetApp ?? (await activeAppOf(provider, ctx.signal))
  if (!app) {
    throw new ToolError(
      `Could not determine which app this action would reach, and the allowlist is limited to: ${allowed.join(', ')}.`,
      'Bring the intended app to the front with open_app first, or ask the user to add "*" to the computer-use allowlist.'
    )
  }
  const names = [app, ...(options.targetAliases ?? [])]
  if (ctx.computerTarget?.kind === 'browser') {
    try {
      const host = new URL(`http://${app}`).hostname
      names.push(host, ...APP_CATALOG.filter((entry) => new URL(entry.url).hostname === host).map((entry) => entry.name))
    } catch { /* an app name, not a host */ }
  }
  if (!names.some((name) => matchesPattern(name, allowed))) {
    throw new ToolError(
      `"${app}" is not in the computer-use allowlist (${allowed.join(', ')}), so the action was refused.`,
      `Ask the user to add "${app}" in Settings → Computer use, or work in one of the allowed apps.`
    )
  }
}

async function activeAppOf(provider: ComputerProvider, signal?: AbortSignal): Promise<string | undefined> {
  const candidate = provider as Partial<AppAware>
  if (typeof candidate.activeApp !== 'function') return undefined
  try {
    return await candidate.activeApp(signal)
  } catch {
    return undefined
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
