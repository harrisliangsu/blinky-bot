/**
 * Reads the slice of user settings the tool layer cares about, with
 * conservative defaults when the host did not supply any.
 */

import type { EffectiveSettings, ToolContext } from './types'

const DEFAULTS: EffectiveSettings = {
  approvalPolicy: 'ask-every-time',
  allowlist: [],
  denylist: [],
  computerUseAllowedApps: []
}

export function settingsOf(ctx: ToolContext): EffectiveSettings {
  const s = ctx.settings
  if (!s) return DEFAULTS
  return {
    approvalPolicy: s.approvalPolicy ?? DEFAULTS.approvalPolicy,
    localExecutionPolicy: s.localExecutionPolicy,
    allowlist: Array.isArray(s.allowlist) ? s.allowlist : [],
    denylist: Array.isArray(s.denylist) ? s.denylist : [],
    computerUseAllowedApps: Array.isArray(s.computerUseAllowedApps) ? s.computerUseAllowedApps : []
  }
}

/**
 * Case-insensitive match of a value against a user-supplied pattern list.
 * `*` alone matches everything; entries may use `*` as a wildcard segment.
 */
export function matchesPattern(value: string, patterns: string[]): boolean {
  const subject = value.toLowerCase()
  return patterns.some((raw) => {
    const pattern = raw.trim().toLowerCase()
    if (!pattern) return false
    if (pattern === '*') return true
    if (!pattern.includes('*')) return subject === pattern || subject.startsWith(`${pattern} `)
    /*
     * A trailing ` *` means "this command, with any arguments" — including
     * none. Without this, `git status *` (the rule the app itself writes when
     * the user clicks "always allow" on `git status`) matched `git status
     * --short` but not a bare `git status`, so the one command they actually
     * approved kept prompting.
     */
    if (pattern.endsWith(' *') && subject === pattern.slice(0, -2).trim()) return true
    const rx = new RegExp(
      `^${pattern
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*')}$`
    )
    return rx.test(subject)
  })
}
