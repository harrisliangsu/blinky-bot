import { setTimeout as delay } from 'node:timers/promises'
import type { Message } from '../../shared/types'
import type { RemoteUpdateReply } from '../../shared/remoteProtocol'
import { workspaceEvents } from './workspaceEvents'
import { roomRealtime } from './realtime'
import { publicRemoteData, publicRemoteMessage } from './publicData'
import { remoteSession, remoteMessageChanges, type RemoteAccess, type RemoteContext } from './workspaceRpc'
import { liveMessages } from '../agent/liveMessages'
import { isRunning } from '../agent/cancel'
import { getMessageQueue } from '../store/messageQueue'
import { pendingCount } from '../agent/approval'
import { roomAccess, RoomAccessError } from './access'

/** Long-poll invalidations are idempotent. The client supplies its last applied cursors. */
export async function remoteUpdates(access: RemoteAccess, context: RemoteContext, input: Record<string, unknown>, allowed: () => boolean, signal: AbortSignal): Promise<RemoteUpdateReply> {
  const since = input.since
  if (!Number.isSafeInteger(since) || (since as number) < 0) throw new RoomAccessError(400, 'Invalid event cursor.')
  const versions = input.versions && typeof input.versions === 'object' && !Array.isArray(input.versions) ? input.versions as Record<string, unknown> : {}
  if (workspaceEvents.since(since as number).revision === since && allowed() && !signal.aborted) {
    await new Promise<void>(resolve => {
      let finished = false
      const end = (): void => { if (finished) return; finished = true; clearTimeout(timer); offEvents(); offAccess(); signal.removeEventListener('abort', end); resolve() }
      const offEvents = workspaceEvents.onChange(end), offAccess = roomAccess.onChange(end), timer = setTimeout(end, 20_000)
      signal.addEventListener('abort', end, { once: true })
    })
  }
  if (!signal.aborted) await delay(40)
  if (!allowed()) throw new RoomAccessError(401, 'This device is no longer approved.')
  if (signal.aborted) throw new RoomAccessError(499, 'The browser disconnected.')
  const changes = workspaceEvents.since(since as number), watched = [...new Set(Object.values(context.slots).filter((id): id is string => !!id))]
  const sessions: RemoteUpdateReply['sessions'] = []
  for (const id of watched) {
    let session
    try { session = remoteSession(access, id) } catch { continue }
    // First load is a bounded page; do not send the whole journal before the
    // browser has applied that page and acknowledged its version.
    if (typeof versions[id] !== 'number' || !Number.isSafeInteger(versions[id])) continue
    const version = versions[id] as number
    const changed = remoteMessageChanges(session, version)
    sessions.push({ id, revision: changed.revision, reset: changed.reset, upserts: changed.upserts, removed: changed.removed, running: isRunning(id), queue: getMessageQueue(id), needsMac: pendingCount(id) > 0 })
  }
  const notices = changes.notices.filter(notice => access.scope === 'workspace' || notice.sessionId === access.room.sessionId)
  return publicRemoteData({ revision: changes.revision, reset: changes.reset, groups: [...new Set(notices.map(notice => notice.kind))], sessions })
}
