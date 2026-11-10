import assert from 'node:assert/strict'
import { test } from 'node:test'
import { store } from './core.ts'
import { applyEvent } from './events.ts'
import { adoptSession, selectSession } from './sessions.ts'
import { visibleAssistantText, visibleModelProgress } from '../lib/messagePresentation.ts'
import type { Message, Session } from '../../../shared/types'

test('follow-ups and switching chats preserve live commentary without leaking internal review', async () => {
  let resolveLive!: (messages: Message[]) => void
  const live = new Promise<Message[]>((resolve) => { resolveLive = resolve })
  const user = (id: string): Message => ({ id, role: 'user', content: id, createdAt: 1 })
  const session = (id: string, messages: Message[] = []): Session => ({ id, title: id, cwd: '/tmp', mode: 'agent', botIds: ['bot'], activeBotId: 'bot', messages, todos: [], createdAt: 1, updatedAt: 1 })
  const source = session('source', [user('u1'), user('u2'), user('u3'), { id: 'm', role: 'assistant', content: 'fir', createdAt: 2, streaming: true, segments: [{ id: 's1', phase: 'commentary', text: 'fir' }] }])
  ;(globalThis as unknown as { window: unknown }).window = {
    requestAnimationFrame: () => 1, cancelAnimationFrame: () => undefined,
    openbot: { sessions: { get: async (id: string) => id === 'source' ? source : session(id) }, agent: { isRunning: async (id: string) => id === 'source', liveMessages: async () => live } }
  }
  adoptSession(session('source', [user('u1')]))
  applyEvent({ type: 'run-started', sessionId: 'source' })
  applyEvent({ type: 'message-start', sessionId: 'source', message: { id: 'm', role: 'assistant', content: '', createdAt: 2, streaming: true } })
  applyEvent({ type: 'text-delta', sessionId: 'source', messageId: 'm', delta: 'first', segment: { id: 's1', phase: 'commentary', delta: 'first', text: 'first' } })
  applyEvent({ type: 'message-start', sessionId: 'source', message: user('u2') })
  applyEvent({ type: 'session-updated', session: session('source', [user('u1'), user('u2')]) })
  applyEvent({ type: 'message-start', sessionId: 'source', message: user('u3') })
  applyEvent({ type: 'text-delta', sessionId: 'source', messageId: 'm', delta: '\n\nsecond', segment: { id: 's2', phase: 'commentary', delta: 'second', text: 'second' } })
  store.flushNow()
  assert.equal(visibleModelProgress(store.getMessage('m')!), 'second')
  assert.equal(store.getState().messageIds.at(-1), 'm')
  applyEvent({ type: 'message-start', sessionId: 'source', message: { id: 'private', role: 'assistant', content: '', createdAt: 3, streaming: true, internal: true } })
  applyEvent({ type: 'text-delta', sessionId: 'source', messageId: 'private', delta: 'secret review', segment: { id: 'p', phase: 'commentary', delta: 'secret review', text: 'secret review' } })
  store.flushNow()
  assert.equal(visibleAssistantText(store.getMessage('private')!), '')
  await selectSession('other')
  const switching = selectSession('source')
  // Events received after the snapshot request are buffered until selection completes.
  await Promise.resolve(); await Promise.resolve()
  applyEvent({ type: 'text-delta', sessionId: 'source', messageId: 'm', delta: ' later', segment: { id: 's2', phase: 'commentary', delta: ' later', text: 'second later' } })
  applyEvent({ type: 'text-delta', sessionId: 'source', messageId: 'm', delta: 'second', segment: { id: 's2', phase: 'commentary', delta: 'second', text: 'second' } })
  resolveLive([{ id: 'm', role: 'assistant', content: 'first\n\nsecond', createdAt: 2, streaming: true, segments: [{ id: 's1', phase: 'commentary', text: 'first' }, { id: 's2', phase: 'commentary', text: 'second' }] }, { id: 'private', role: 'assistant', content: 'secret review', createdAt: 3, streaming: true, internal: true, segments: [{ id: 'p', phase: 'commentary', text: 'secret review' }] }])
  await switching
  store.flushNow()
  assert.equal(visibleModelProgress(store.getMessage('m')!), 'second later')
  assert.equal(visibleAssistantText(store.getMessage('private')!), '')
  applyEvent({ type: 'text-delta', sessionId: 'source', messageId: 'm', delta: '\n\nfinal', segment: { id: 's3', phase: 'final_answer', delta: 'final', text: 'final' } })
  store.flushNow()
  assert.equal(visibleAssistantText(store.getMessage('m')!), 'final')
})
