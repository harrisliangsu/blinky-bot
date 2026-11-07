/**
 * The message lifecycle: create, announce, persist, close.
 *
 * Every message the agent produces goes through here, so `message-start` / `message-end`
 * always pair up and the session on disk always matches what the renderer was told.
 */

import type { Attachment, Bot, Message, Session, ToolResult } from '../../shared/types'
import { broadcast } from './events'
import { newId, now } from './ids'
import { sessions } from './sessionGateway'
import { captureUserPreference } from './memoryPreferences'
import { scrubVaultMessage } from '../store/vaultPrivacy'

export function assistantMessage(bot: Bot): Message {
  return {
    id: newId('msg'),
    role: 'assistant',
    content: '',
    botId: bot.id,
    model: bot.modelId,
    createdAt: now(),
    streaming: true
  }
}

/** Announce a message that is about to stream. */
export function begin(sessionId: string, message: Message): void {
  broadcast({ type: 'message-start', sessionId, message: scrubVaultMessage(message) })
}

/** Close a streaming message: persist it and tell the renderer it is final. */
export async function commit(session: Session, message: Message): Promise<void> {
  message.streaming = false
  if (message.role === 'assistant' && message.segments?.length && message.displayContent === undefined) {
    // Storage may discard phase metadata after ACTION stripping, de-duplication
    // or appending an error. Preserve the public body for that reload path.
    const answers = message.segments.filter((part) => part.phase !== 'commentary' && part.text.trim())
    message.displayContent = (answers.length ? answers : message.segments).map((part) => part.text).join('\n\n')
  }
  message = scrubVaultMessage(message)
  const saved = await sessions.update(session, (fresh) => {
    const at = fresh.messages.findIndex((item) => item.id === message.id)
    if (at >= 0) fresh.messages[at] = message
    else fresh.messages.push(message)
  })
  if (!saved) throw new Error('The message could not be saved; the turn was not continued.')
  broadcast({
    type: 'message-end',
    sessionId: session.id,
    messageId: message.id,
    content: message.content,
    displayContent: message.displayContent,
    segments: message.segments,
    toolCalls: message.toolCalls,
    error: message.error,
    internal: message.internal
  })
}

export async function addUserMessage(
  session: Session,
  text: string,
  attachments?: Attachment[],
  announceSnapshot = true,
  messageId?: string,
  createdAt?: number,
  internal = false
): Promise<Message> {
  const message: Message = {
    id: messageId ?? newId('msg'),
    role: 'user',
    content: text,
    attachments: attachments?.length ? attachments : undefined,
    createdAt: createdAt ?? now(),
    ...(internal ? { internal: true } : {})
  }
  begin(session.id, message)
  await commit(session, message)
  // Queued messages already captured on acceptance; do not revive a memory
  // the user deleted while its message was waiting for delivery.
  if (!internal && !messageId) await captureUserPreference(text, message.id)
  if (announceSnapshot) broadcast({ type: 'session-updated', session })
  return message
}

/** Tool results are already streamed as `tool-result`; this only records them. */
export async function addToolMessage(
  session: Session,
  botId: string,
  result: ToolResult
): Promise<Message> {
  const message: Message = {
    id: newId('msg'),
    role: 'tool',
    content: result.output,
    toolResult: result,
    botId,
    createdAt: now()
  }
  const safeMessage = scrubVaultMessage(message)
  const saved = await sessions.update(session, (fresh) => {
    fresh.messages.push(safeMessage)
  })
  if (!saved) throw new Error('The tool result could not be saved; the turn was not continued.')
  return safeMessage
}

/**
 * A complete assistant message with no streaming — cap notices, aborted-run notes and
 * other things the loop says on its own behalf.
 */
export async function addNotice(
  session: Session,
  bot: Bot | null,
  text: string,
  error?: string,
  messageId?: string,
  uiOnly = false
): Promise<Message> {
  const message: Message = {
    id: messageId ?? newId('msg'),
    role: 'assistant',
    content: text,
    botId: bot?.id,
    model: bot?.modelId,
    createdAt: now(),
    streaming: false,
    error,
    ...(uiOnly ? { uiOnly: true } : {})
  }
  begin(session.id, message)
  await commit(session, message)
  return message
}
