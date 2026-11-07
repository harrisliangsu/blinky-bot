/**
 * Session ids a CLI minted itself.
 *
 * Kimi and Grok name the conversation in their own stream. The next turn
 * resumes that id. Inventing one, the way Claude's `--session-id` allows,
 * is rejected by both of these CLIs.
 */

import { forgetProviderBinding, getProviderBinding, putProviderBinding } from '../../store/providerBindings'

/** An id safe to place after `--session` / `--resume`. Anything else is dropped. */
export function cliSessionToken(id: string | undefined): string | undefined {
  if (!id) return undefined
  const clean = id.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(clean)) return undefined
  return clean
}

export function rememberedCliSession(backendId: string, sessionKey: string | undefined): string | undefined {
  return cliSessionToken(getProviderBinding(backendId, sessionKey)?.nativeThreadId)
}

export function rememberCliSession(backendId: string, sessionKey: string | undefined, cliSessionId: string): void {
  const token = cliSessionToken(cliSessionId)
  if (!sessionKey || !token) return
  putProviderBinding(backendId, sessionKey, { nativeThreadId: token })
}

export function forgetCliSession(backendId: string, sessionKey: string | undefined): void {
  forgetProviderBinding(backendId, sessionKey)
}
