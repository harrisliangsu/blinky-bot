import type { AppId, AppStatus } from '../../../shared/apps'

// Display-only history. It never grants access and intentionally contains no
// credentials, account identifiers, or transient network error details.
const KEY = 'blinky.apps.last-known.v1'
const IDS: AppId[] = ['github', 'git', 'gmail', 'calendar', 'slack', 'x']
type StatusStorage = Pick<Storage, 'getItem' | 'setItem'>

export function readLastAppStatuses(storage: StatusStorage): AppStatus[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(KEY) ?? '[]')
    if (!Array.isArray(value)) return []
    const rows: AppStatus[] = []
    for (const item of value) {
      if (!item || typeof item !== 'object') continue
      const { id, status } = item as Record<string, unknown>
      if (typeof id !== 'string' || !IDS.includes(id as AppId) || (status !== 'connected' && status !== 'disconnected') || rows.some((row) => row.id === id)) continue
      rows.push({ id: id as AppId, status })
    }
    return rows
  } catch { return [] }
}

export function saveLastAppStatuses(storage: StatusStorage, incoming: AppStatus[]): void {
  try {
    const rows = readLastAppStatuses(storage)
    for (const item of incoming) {
      if (!IDS.includes(item.id) || (item.status !== 'connected' && item.status !== 'disconnected')) continue
      const index = rows.findIndex((row) => row.id === item.id)
      const safe: AppStatus = { id: item.id, status: item.status }
      if (index === -1) rows.push(safe)
      else rows[index] = safe
    }
    storage.setItem(KEY, JSON.stringify(rows))
  } catch { /* Storage may be unavailable; fresh checks still work. */ }
}
