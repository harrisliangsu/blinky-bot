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
}

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
