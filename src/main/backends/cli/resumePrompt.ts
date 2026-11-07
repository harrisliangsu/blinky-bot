/**
 * What a RESUMED agent-CLI turn actually sends.
 *
 * A resumed conversation is already held by the CLI, so re-sending the whole
 * transcript hands it every earlier turn a second time. Sending only the newest
 * user message is the opposite failure, and the one that shipped: in a
 * multi-bot session the newest user message is the moderator's floor brief, so
 * the teammate's reply and the user's own question never reached the model at
 * all — captured stdin showed the CLI receiving nothing but "[moderator] …".
 *
 * What is new is therefore computed rather than guessed. Each turn records a
 * fingerprint per message; the next turn sends everything past the longest
 * prefix the CLI has already been given. A transcript re-budgeted between turns
 * simply shares a shorter prefix, so the failure mode is sending a little too
 * much — never too little.
 */

import { createHash } from 'node:crypto'
import { textOf } from '../messageContent'
import type { ProviderMessage } from '../types'
import { clearDeliveredFingerprints, deliveredFingerprints, setDeliveredFingerprints } from '../../store/providerBindings'

/**
 * One fingerprint per message. Role and text only: tool metadata and images
 * change shape between turns without the turn itself having changed.
 */
export function fingerprints(messages: ProviderMessage[]): string[] {
  return messages.map((message) =>
    createHash('sha256')
      .update(`${message.role}\0${textOf(message.content)}`)
      .digest('base64')
  )
}

/** Index of the first message this conversation has not been given yet. */
export function firstUnsent(sessionKey: string | undefined, current: string[]): number {
  const previous = deliveredFingerprints(sessionKey)
  let i = 0
  while (i < previous.length && i < current.length && previous[i] === current[i]) i++
  return i
}

/** Record what this turn handed over, once it actually went out. */
export function rememberSent(sessionKey: string | undefined, current: string[]): void {
  setDeliveredFingerprints(sessionKey, current)
}

/**
 * Forget the watermark, so the next turn re-sends the transcript in full.
 *
 * Called with the CLI's stored conversation: a thread that is being restarted
 * has none of the history the watermark claims it has.
 */
export function forgetSent(sessionKey: string | undefined): void {
  clearDeliveredFingerprints(sessionKey)
}
