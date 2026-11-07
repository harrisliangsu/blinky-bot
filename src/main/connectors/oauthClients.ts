/** Distributor-owned native clients. Never borrow another application's identity. */
// electron-vite embeds MAIN_VITE_* in the main bundle only. Runtime BLINKY_*
// overrides support local distributions; neither path reaches the renderer.
const bundled = (import.meta as ImportMeta & { env?: Record<string, string> }).env ?? {}

export interface GoogleClient { clientId: string; clientSecret?: string }
export function googleClient(): GoogleClient | undefined {
  const clientId = (process.env.BLINKY_GOOGLE_CLIENT_ID ?? bundled.MAIN_VITE_GOOGLE_CLIENT_ID ?? '').trim()
  if (!clientId) return undefined
  const clientSecret = (process.env.BLINKY_GOOGLE_CLIENT_SECRET ?? bundled.MAIN_VITE_GOOGLE_CLIENT_SECRET ?? '').trim()
  validateGoogleClient(clientId, clientSecret)
  return { clientId, ...(clientSecret ? { clientSecret } : {}) }
}
export function xClientId(): string | undefined {
  const value = (process.env.BLINKY_X_CLIENT_ID ?? bundled.MAIN_VITE_X_CLIENT_ID ?? '').trim()
  if (!value) return undefined
  validateXClient(value)
  return value
}
export function slackClientId(): string | undefined {
  const value = (process.env.BLINKY_SLACK_CLIENT_ID ?? bundled.MAIN_VITE_SLACK_CLIENT_ID ?? '').trim()
  if (!value) return undefined
  if (!/^\d{2,30}\.\d{2,30}$/.test(value)) throw new Error('A valid Slack public client ID is required.')
  return value
}
export function validateGoogleClient(clientId: string, secret = ''): void {
  if (!/^[A-Za-z0-9_-]{8,200}\.apps\.googleusercontent\.com$/.test(clientId) || secret.length > 1024 || /[\r\n\0]/.test(secret)) throw new Error('A valid Google desktop OAuth client ID is required.')
}
export function validateXClient(clientId: string): void {
  if (!/^[A-Za-z0-9_-]{8,500}$/.test(clientId)) throw new Error('A valid X public client ID is required.')
}
