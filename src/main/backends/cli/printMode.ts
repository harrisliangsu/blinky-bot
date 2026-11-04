import type { ChatRequest } from '../types'

/**
 * Print mode on Kimi and Grok has no permission callback and no way to hand
 * the turn to BlinkyBot's tool loop. A background side call, and a VM bot that
 * must not touch this Mac, therefore fail closed instead of spawning the CLI.
 */
export function refuseUngovernedSideCall(displayName: string, req: ChatRequest): void {
  if (req.readOnly === true) {
    throw new Error(
      `${displayName} has no text-only print mode, so BlinkyBot refused a background side call ` +
        'rather than start an unattended agent with its own tools.'
    )
  }
  if (req.disableNativeTools === true) {
    throw new Error(
      `${displayName} runs its own tools on this machine, so it cannot be the model for a private computer. ` +
        'Use pi, or a direct API backend, for a VM bot.'
    )
  }
}
