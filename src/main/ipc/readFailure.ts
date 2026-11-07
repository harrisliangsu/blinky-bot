/** Read errors must not look like an empty list or a missing conversation.
 * Keep the public rejection generic: paths, raw protocol and credentials from
 * a lower-level exception do not belong in a renderer diagnostic. */
export function unreadableRecord(): never {
  throw new Error('Saved execution records could not be read. Please retry.')
}
