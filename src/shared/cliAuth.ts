/**
 * Login state for an agent CLI, as reported by that CLI.
 *
 * BlinkyBot does not store the credential. The state is a label the CLI
 * printed, or the fact that its documented credential file exists.
 */

export type CliAuthState = 'not-installed' | 'logged-out' | 'logged-in' | 'unknown'

export interface CliAuthInfo {
  state: CliAuthState
  /** Non-secret account label, such as an email or "ChatGPT". */
  account?: string
}

/** These CLIs sign in with `/login` inside their own terminal session. */
export const CLI_SLASH_LOGIN_IDS: readonly string[] = ['pi', 'droid']
