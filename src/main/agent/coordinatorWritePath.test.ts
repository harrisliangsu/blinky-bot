import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Bot, MemoryEntry, Session, Settings, ToolSchema } from '../../shared/types'
import { buildContext } from './context'

function schema(name: string): ToolSchema {
  return { name, description: `${name} tool`, parameters: { type: 'object', properties: {} }, mutating: ['write_file', 'edit_file', 'delegate_task'].includes(name) }
}

function bot(overrides: Partial<Bot>): Bot {
  return {
    id: 'lead', name: 'Lead', systemPrompt: '', backendId: 'codex', modelId: 'default',
    computerUse: false, tools: ['read_file', 'write_file', 'edit_file', 'delegate_task'],
    ...overrides
  } as Bot
}

function session(): Session {
  return { id: 'chat', mode: 'agent', messages: [] } as unknown as Session
}

function promptFor(b: Bot, schemas: string[]): string {
  return buildContext({
    bot: b, session: session(), settings: {} as Settings, memory: [] as MemoryEntry[],
    schemas: schemas.map(schema), roster: [b], supportsVision: false
  }).systemPrompt
}

const WRITE_PATH = /# Write path \(native sandbox is read-only\)/
const EXCEPTION = /Exception: a refused native write or patch is the read-only native sandbox/

test('a codex lead coordinator is told its native sandbox is read-only and the application tools are the only write path', () => {
  const lead = bot({ executionAgent: { backendId: 'codex', modelId: 'default' } })
  const prompt = promptFor(lead, ['read_file', 'write_file', 'edit_file', 'delegate_task'])
  assert.match(prompt, WRITE_PATH)
  assert.match(prompt, /use the application tools write_file and edit_file/)
  assert.match(prompt, /complete the same change with write_file\/edit_file instead of giving up/)
  assert.match(prompt, EXCEPTION)
})

test('a codex bot without an execution agent gets no coordinator write-path contract', () => {
  const plain = bot({})
  const prompt = promptFor(plain, ['read_file', 'write_file', 'edit_file'])
  assert.doesNotMatch(prompt, WRITE_PATH)
  assert.doesNotMatch(prompt, EXCEPTION)
})

test('a non-codex lead coordinator gets no codex-native write-path contract', () => {
  const lead = bot({ backendId: 'claude', executionAgent: { backendId: 'claude', modelId: 'default' } })
  const prompt = promptFor(lead, ['read_file', 'write_file', 'edit_file', 'delegate_task'])
  assert.doesNotMatch(prompt, WRITE_PATH)
  assert.doesNotMatch(prompt, EXCEPTION)
  assert.match(prompt, /# Independent execution agent/)
})
