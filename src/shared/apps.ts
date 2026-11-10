/**
 * Connector ids shared by every Bot.
 * The installed Apps grid offers GitHub, Gmail, and X.
 * Git identity is not an App. Calendar and Slack stay implemented and hidden.
 */
export type AppId = 'github' | 'git' | 'gmail' | 'calendar' | 'slack' | 'x'

/** First-party connections a normal user can connect from Apps. */
export const INSTALLED_APP_IDS = ['github', 'gmail', 'x'] as const
export type InstalledAppId = (typeof INSTALLED_APP_IDS)[number]

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
