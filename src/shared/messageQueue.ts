import type { Attachment } from './chat'

export interface QueuedMessage {
  id: string
  text: string
  attachments: Attachment[]
  /** processing means saved in the transcript; the run has not yet finished. */
  status: 'waiting' | 'running' | 'processing' | 'interrupted'
  createdAt: number
  /** External channel messages are intended for one specific Bot. */
  targetBotId?: string
}

export interface MessageQueue {
  sessionId: string
  paused: boolean
  items: QueuedMessage[]
}
