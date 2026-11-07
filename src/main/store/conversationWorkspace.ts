import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { dataRoot } from './paths'

/** New loose chats own a directory. Existing/explicit project paths are never migrated. */
export function createConversationWorkspace(botIds: string[], sessionId: string): string {
  const identity = [...new Set(botIds)].sort().join('\0') || 'unassigned'
  const namespace = botIds.length > 1 ? 'groups' : 'bots'
  const group = createHash('sha256').update(identity).digest('hex').slice(0, 24)
  const path = join(dataRoot(), 'workspaces', namespace, group, 'conversations', sessionId)
  mkdirSync(path, { recursive: true, mode: 0o700 })
  return path
}
