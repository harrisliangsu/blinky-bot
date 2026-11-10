/**
 * How much of a long conversation is rendered at once.
 *
 * Every assistant bubble parses its markdown on mount — marked, then highlight,
 * then a DOMParser pass to sanitize — inside a `useMemo` that is cold the first
 * time. Rendering a whole history therefore does all of that work synchronously
 * in one commit: opening a 500-turn chat froze the window, and the workspace
 * multiplied it, because up to six unfocused panes each rendered their entire
 * history as a snapshot.
 *
 * A conversation is read from the bottom, so the newest turns are rendered and
 * the rest stays one click away.
 */

/** Turns the transcript renders before offering "show earlier". */
export const TRANSCRIPT_WINDOW = 200

/**
 * Turns a snapshot pane renders. Far smaller: a quarter-width pane shows a
 * handful of turns at a time, nobody reads history in one, and there can be six.
 */
export const SNAPSHOT_WINDOW = 40

export interface Windowed<T> {
  visible: T[]
  /** How many older entries were left out. */
  hidden: number
}

/** The newest `limit` entries, and the count of what that left behind. */
export function tailWindow<T>(items: readonly T[], limit: number, include?: (item:T)=>boolean): Windowed<T> {
  // Private orchestration may be frequent, but must never evict real chat from
  // the visible window or inflate the user's "earlier messages" count.
  const records=include?items.filter(include):items
  // A nonsense limit must never blank the transcript: render everything and let
  // it be slow rather than let a bad number hide the conversation.
  if (!Number.isFinite(limit) || limit < 1 || records.length <= limit) {
    return { visible: records.slice(), hidden: 0 }
  }
  return { visible: records.slice(records.length - limit), hidden: records.length - limit }
}
