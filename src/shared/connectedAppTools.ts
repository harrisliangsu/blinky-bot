import type { AppId } from './apps'
export type ConnectedApp = Exclude<AppId, 'git'>
/** Reading and local drafts only. Actual sending retains its existing user gate. */
export const CONNECTED_APP_TOOLS: Readonly<Record<ConnectedApp, readonly string[]>> = {
  gmail: ['search_gmail', 'read_gmail', 'gmail_draft'],
  calendar: ['list_calendar_events', 'calendar_event_draft'],
  x: ['read_x_post', 'x_post_draft'],
  slack: ['slack_message_draft'],
  github: ['github_comment_draft']
}
export const isConnectedApp = (value: unknown): value is ConnectedApp => typeof value === 'string' && Object.hasOwn(CONNECTED_APP_TOOLS, value)
