import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clarificationTimeline } from './clarificationTimeline.ts'
import type { AgentTaskClarification, Message } from '../../../shared/types'
const m = (id: string, createdAt: number): Message => ({ id, createdAt, role: 'user', content: id })
const q = (id: string, createdAt: number, extra: Partial<AgentTaskClarification> = {}): AgentTaskClarification => ({ id, createdAt, updatedAt: createdAt, taskId: 't', sourceSessionId: 's', executionSessionId: 'e', botId: 'b', questions: [{ id: 'q', header: '', question: id }], status: 'waiting_user', ...extra })
const ids = (messages: Message[], requests: AgentTaskClarification[], more = false) => clarificationTimeline(messages, requests, more).map(entry => entry.id)
test('legacy notice position wins over updatedAt and backdated timestamps; answer never sinks', () => {
 const messages = [m('u1', 1), m('task-clarification-q1', 9), m('u2', 2), m('task-clarification-q2', 10), m('u3', 3)]
 const questions = [q('q1', 1), q('q2', 2)]
 const expected = ['u1','clarification:q1','u2','clarification:q2','u3']
 assert.deepEqual(ids(messages, questions), expected)
 assert.deepEqual(ids(messages, questions.map(value => ({ ...value, status: 'answered', answeredBy: 'user', answers: { q: ['选择一'] }, updatedAt: 999 }))), expected)
 assert.deepEqual(ids([...messages,m('u4', 1000)], questions), [...expected,'u4'])
})
test('remote public pages use original source-message association and askedAt rather than answer time', () => {
 const requests = [q('a', 1, { afterMessageId: 'u1', askedAt: 3, updatedAt: 100 }), q('b', 2, { askedAt: 6 })]
 assert.deepEqual(ids([m('u1', 2),m('u2', 4),m('u3', 8)], requests), ['u1','clarification:a','u2','clarification:b','u3'])
})
test('outside-page questions await earlier history, then appear once; no 16-card data loss', () => {
 const messages = Array.from({length:40},(_,i)=>m('u'+i,i*10))
 const requests = messages.map((message,i)=>q('q'+i,message.createdAt+1,{status:'answered',answeredBy:'user'}))
 assert.equal(ids(messages.slice(-10),requests,true).filter(id=>id.startsWith('clarification:')).length,10)
 assert.equal(ids(messages,requests).filter(id=>id.startsWith('clarification:')).length,40)
 assert.equal(new Set(ids(messages,[...requests,...requests])).size,80)
})
test('legacy timestamps fall back only without an anchor; cancelled and expired remain truthful', () => {
 assert.deepEqual(ids([m('u1',1),m('u2',5)], [q('a',2,{status:'cancelled'}),q('b',3,{status:'expired'}),q('bot',4,{status:'answered',answeredBy:'bot'}),q('inference',4,{status:'answering'})]), ['u1','clarification:a','clarification:b','u2'])
})
