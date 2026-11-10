import { useSyncExternalStore } from 'react'
import { store } from '../state/core'
import { tryBridge } from '../state/bridge'

const runs = new Map<string, string>()
const owners = new Map<string, string>()
const versions = new Map<string, number>()
const listeners = new Set<() => void>()
let detach: (() => void) | undefined
const emit = (): void => { for (const listener of listeners) listener() }

function isConversationOwner(sessionId: string, botId: string): boolean {
  const state = store.getState()
  return state.bots.some(bot => bot.id === botId && bot.activeConversationId === sessionId)
    || (state.session?.id === sessionId && state.session.activeBotId === botId)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!detach) {
    const api = tryBridge()
    const stopStore = store.subscribe(emit)
    const stopEvents = api?.on(event => {
      if (!('sessionId' in event) && event.type !== 'session-updated') return
      const id = event.type === 'session-updated' ? event.session.id : event.sessionId
      versions.set(id, (versions.get(id) ?? 0) + 1)
      if (event.type === 'session-updated') owners.set(id, event.session.activeBotId)
      if (event.type === 'run-started') {
        const state = store.getState()
        const owner = owners.get(id) ?? (state.session?.id === id ? state.session.activeBotId : state.bots.find(bot => bot.activeConversationId === id)?.id)
        if (owner && isConversationOwner(id, owner)) runs.set(id, owner)
      }
      if (event.type === 'message-start' && event.message.role === 'assistant' && event.message.botId && event.message.streaming && isConversationOwner(id, event.message.botId)) runs.set(id, event.message.botId)
      if (event.type === 'handoff') { owners.set(id, event.toBotId); if (runs.has(id)) runs.set(id, event.toBotId) }
      if (event.type === 'done' || event.type === 'error') runs.delete(id)
      emit()
    })
    // Recover already-running home conversations when the renderer attaches.
    for (const bot of store.getState().bots) {
      const id = bot.activeConversationId
      if (!id || !api) continue
      owners.set(id, bot.id)
      const version = versions.get(id) ?? 0
      void api.agent.isRunning(id).then(running => {
        if (listeners.size && running && (versions.get(id) ?? 0) === version) { runs.set(id, bot.id); emit() }
      }).catch(() => {})
    }
    detach = () => { stopStore(); stopEvents?.() }
  }
  return () => {
    listeners.delete(listener)
    if (!listeners.size) { detach?.(); detach = undefined; runs.clear(); owners.clear(); versions.clear() }
  }
}

/** Run completion/error, rather than an individual message end, recenters eyes. */
export function useAvatarActivity(botId?: string): boolean {
  const read = (): boolean => {
    if (!botId) return false
    const state = store.getState()
    return (state.streaming && state.session?.activeBotId === botId) || [...runs.values()].includes(botId)
  }
  return useSyncExternalStore(subscribe, read, () => false)
}
