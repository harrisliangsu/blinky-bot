/**
 * What the chat says when a turn cannot start a model backend.
 *
 * The transcript and the run banner both key off these sentences, so the
 * wording lives here rather than in the turn loop. A raw `spawn … ENOENT`
 * is the failure this replaces: a Finder-launched app often cannot see the
 * CLI the user installed, and the old message named that errno.
 */

export interface BackendStartInfo {
  label: string
  status: string
  /**
   * Set on a placeholder row that has not been probed yet.
   * `chatStartBlock` will not refuse a turn on that placeholder.
   */
  statusDetail?: string
}

/** Status detail of a row filled in before any probe has run. */
export const UNCHECKED_BACKEND_DETAIL = 'Not checked yet.'

/** True when the process never started because the executable was missing. */
export function isMissingExecutableError(text: string): boolean {
  return /spawn\s+\S+\s+ENOENT/i.test(text)
}

/**
 * Block before spawning when this backend is missing or not signed in.
 * `available`, `error`, and `not-running` still try the connection: a probe
 * timeout is not proof the CLI is absent.
 */
export function backendStartBlock(
  info: BackendStartInfo | null,
  infos: readonly { status: string }[],
  fallbackLabel: string
): string | null {
  if (info && info.status !== 'not-installed' && info.status !== 'needs-key') return null
  const nothingReady = !infos.some((item) => item.status === 'available')
  return unavailableBackendMessage({
    label: info?.label || fallbackLabel,
    nothingReady
  })
}

/**
 * Whether this chat turn should refuse to start before trying the backend.
 *
 * A placeholder (`Not checked yet`) is not evidence the CLI is missing. Blocking
 * on it forced every send to wait for a version check and a sign-in probe of
 * every installed agent, or refused a backend the app simply had not scanned.
 * A real `not-installed` / `needs-key` result still fails fast.
 */
export function chatStartBlock(
  info: BackendStartInfo | null,
  infos: readonly { status: string }[],
  fallbackLabel: string
): string | null {
  if (!info || info.statusDetail === UNCHECKED_BACKEND_DETAIL) return null
  return backendStartBlock(info, infos, fallbackLabel)
}

export function unavailableBackendMessage(input: { label: string; nothingReady: boolean }): string {
  if (input.nothingReady) {
    return (
      'No signed-in model backend is available, so this chat cannot start. ' +
      'Install Codex, Claude Code, or OpenCode, sign in, and choose it in Settings → Backends.'
    )
  }
  return (
    `${input.label} is not installed or not signed in, so this chat cannot start. ` +
    'Choose a signed-in backend in Settings → Backends.'
  )
}

/** The transcript turns this sentence into a button that opens that section. */
export function isBackendSetupMessage(text: string): boolean {
  return (
    text.includes('Settings → Backends') &&
    (text.startsWith('No signed-in model backend is available') ||
      text.includes('is not installed or not signed in, so this chat cannot start'))
  )
}

/** Keep a real CLI failure; replace a missing-executable spawn with the setup prompt. */
export function explainStartupFailure(raw: string, friendly: string, wrapped: string): string {
  return isMissingExecutableError(raw) ? friendly : wrapped
}
