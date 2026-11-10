import type { WebContents } from 'electron'

/** Weak keys keep closed/reloaded windows from retaining subscriptions. */
const observed = new WeakMap<WebContents, Map<'chat' | 'agent', string>>()
export function observeSession(sender: WebContents, slot: 'chat' | 'agent', id: string | null): void {
  let slots = observed.get(sender)
  if (!slots) { slots = new Map(); observed.set(sender, slots) }
  if (id) slots.set(slot, id)
  else slots.delete(slot)
}
export function observesSession(sender: WebContents, id: string): boolean {
  return [...observed.get(sender)?.values() ?? []].includes(id)
}
