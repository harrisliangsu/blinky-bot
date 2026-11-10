import type { AgentEvent, Message, Session } from './types'
export interface RemotePage { sessionId: string; olderCursor: string | null; newerCursor: string | null; hasMore: boolean; hasNewer: boolean; revision: number }
export interface RemoteRpcReply { value: unknown; page?: RemotePage; changes?: { revision: number; reset: boolean; upserts: Array<{ message: Message; move: boolean }>; removed: string[] }; receipt?: { id: string; duplicate: boolean } }
export interface RemoteUpdateReply {
  revision: number
  reset: boolean
  groups: string[]
  sessions: Array<{ id: string; revision: number; reset: boolean; upserts: Array<{ message: Message; move: boolean }>; removed: string[]; running: boolean; queue: import('./messageQueue').MessageQueue; needsMac: boolean }>
}
