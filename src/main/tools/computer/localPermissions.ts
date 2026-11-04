/**
 * macOS privacy-permission detection for the local computer provider.
 *
 * Computer use needs two TCC grants, and they fail in completely different
 * ways, so each is detected separately and reported with the exact pane to
 * open. Nothing here executes anything — it interprets exit codes and stderr
 * produced by `localCapture.ts` / `localInput.ts`.
 */

import { ToolError } from '../errors'

export type MacPermission = 'accessibility' | 'screen-recording' | 'automation'

/** Deep links that open the right pane of System Settings directly. */
export const SETTINGS_PANE: Record<MacPermission, string> = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  'screen-recording': 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation'
}

const PANE_LABEL: Record<MacPermission, string> = {
  accessibility: 'Privacy & Security → Accessibility',
  'screen-recording': 'Privacy & Security → Screen & System Audio Recording',
  automation: 'Privacy & Security → Automation'
}

const WHAT_IT_UNLOCKS: Record<MacPermission, string> = {
  accessibility: 'moving the pointer, clicking, typing and pressing keys',
  'screen-recording': 'taking screenshots of the display',
  automation: 'sending commands to other apps (System Events)'
}

/**
 * Signatures observed when a TCC grant is missing.
 * -1719 / -25211: System Events refused because the caller is not trusted.
 * -1743: the caller was never authorised to send Apple events at all.
 */
const SIGNATURES: Array<{ permission: MacPermission; rx: RegExp }> = [
  { permission: 'accessibility', rx: /not allowed assistive access/i },
  { permission: 'accessibility', rx: /is not allowed to send keystrokes/i },
  { permission: 'accessibility', rx: /\(-(?:1719|25211)\)/ },
  { permission: 'accessibility', rx: /osascript is not allowed/i },
  { permission: 'automation', rx: /not authoriz(?:ed|ing) to send apple events/i },
  { permission: 'automation', rx: /\(-1743\)/ },
  { permission: 'screen-recording', rx: /screencapture: cannot run/i },
  { permission: 'screen-recording', rx: /not authorized to capture/i },
  { permission: 'screen-recording', rx: /screen recording permission/i }
]

/** Identify which grant is missing from a failed `osascript` / `screencapture` run. */
export function detectPermissionFailure(stderr: string, code: number | null): MacPermission | undefined {
  const text = stderr ?? ''
  for (const sig of SIGNATURES) if (sig.rx.test(text)) return sig.permission
  // osascript exits 1 for both script errors and refusals; only treat a bare
  // exit 1 as a permission problem when nothing else explains it.
  if (code === 1 && /execution error/i.test(text) && /system events/i.test(text)) return 'accessibility'
  return undefined
}

/**
 * The message the user actually needs: what broke, which pane to open, and
 * that the app must be re-launched after granting.
 */
export function permissionError(permission: MacPermission, context?: string): ToolError {
  const app = hostAppLabel()
  return new ToolError(
    `${context ? `${context} ` : ''}macOS blocked this: BlinkyBot does not have ${PANE_LABEL[permission]} permission, ` +
      `which is what allows ${WHAT_IT_UNLOCKS[permission]}.`,
    [
      `Fix it: open System Settings → ${PANE_LABEL[permission]}, then switch on "${app}".`,
      `Shortcut: open ${SETTINGS_PANE[permission]}`,
      permission === 'screen-recording'
        ? 'macOS only applies a new Screen Recording grant after the app is quit and re-opened.'
        : 'If the entry is already on, switch it off and on again — the grant is tied to the app binary and goes stale after an update.'
    ].join('\n')
  )
}

/**
 * The name the user will look for in the permission list. In a packaged build
 * this is the app itself; in development macOS attributes the request to the
 * Electron binary that is running.
 */
export function hostAppLabel(): string {
  const execPath = process.execPath ?? ''
  const bundleMatch = /\/([^/]+)\.app\//.exec(execPath)
  if (bundleMatch) return bundleMatch[1]
  return 'BlinkyBot (in development, this appears as "Electron")'
}

/** Wrap a non-permission failure so the model still gets something actionable. */
export function commandError(what: string, stderr: string, code: number | null): ToolError {
  const detail = (stderr || '').trim().split('\n').slice(0, 4).join('\n')
  return new ToolError(
    `${what} failed${code === null ? '' : ` (exit ${code})`}${detail ? `: ${detail}` : '.'}`,
    'This is a macOS automation failure rather than a permission problem. Take a fresh screenshot to see the current state before retrying.'
  )
}
