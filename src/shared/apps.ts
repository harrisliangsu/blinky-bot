/** App connections shared by every Bot. P1 is GitHub, Git, and Gmail. */

export type AppId = 'github' | 'git' | 'gmail' | 'calendar' | 'slack' | 'x'

export type AppConnectionStatus = 'connected' | 'disconnected' | 'unavailable' | 'pending'

export interface AppStatus {
  id: AppId
  status: AppConnectionStatus
  /** Login name, or `name <email>` for Git. Never a token. */
  account?: string
  accounts?: Array<{ id: string; label: string; isDefault: boolean; status: AppConnectionStatus; detail?: string }>
  detail?: string
}

export interface AppLinkState {
  /**
   * Gmail only, until Google sign-in exists. True means the user asked to
   * connect. It is not a successful login.
   */
  pending?: boolean
}

export type AppLinks = Record<AppId, AppLinkState>
