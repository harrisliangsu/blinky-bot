import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Bot, MemoryEntry, Session, Settings } from '../../shared/types'
import { buildContext } from './context'
import { rankMemory } from './memoryRecall'

function note(id: string, text: string, createdAt: number, preference = false): MemoryEntry {
  return { id, botId: 'one', text, createdAt, source: preference ? 'user' : 'run', ...(preference ? { tags: ['user-preference'] } : {}) }
}

test('Chinese and mixed-language topics retrieve older relevant preferences ahead of unrelated notes', () => {
  const input = [
    note('unrelated', '喜欢户外运动和咖啡', 100),
    note('preview', '打包流程：只生成 Preview 包并打开', 1, true),
    note('model', 'Kimi模型选项需要显示可用模型', 2, true)
  ]
  assert.equal(rankMemory(input, 'Kimi模型无法选择')[0].id, 'model')
  assert.equal(rankMemory(input, '现在验证打包流程')[0].id, 'preview')
  assert.deepEqual(input.map((item) => item.id), ['unrelated', 'preview', 'model'])
})

test('recent corrections outrank older overlapping preferences', () => {
  const entries = [note('old', '以后打包流程必须打正式包', 1, true), note('new', '不要打正式包，只打测试包', 2, true)]
  assert.deepEqual(rankMemory(entries, '打包正式包').map((item) => item.id), ['new', 'old'])
})

test('the real context selects relevant old memory even with many newer notes and ignores internal messages', () => {
  const memory = [note('specific', '打包流程需要打开独立测试包供我验证', 1, true)]
  for (let i = 0; i < 50; i++) memory.push(note(`other-${i}`, `一般信息 ${i} ${'x'.repeat(350)}`, 100 + i))
  const bot = { id: 'one', name: 'Blinky', systemPrompt: '', backendId: 'codex', modelId: 'default', computerUse: false } as Bot
  const session = { id: 'chat', mode: 'agent', messages: [
    { id: 'u', role: 'user', content: '检查打包流程', createdAt: 1 },
    { id: 'i', role: 'user', content: '一般信息', internal: true, createdAt: 2 }
  ] } as Session
  const result = buildContext({ bot, session, settings: {} as Settings, memory, schemas: [], roster: [bot], supportsVision: false })
  assert.match(result.systemPrompt, /打包流程需要打开独立测试包供我验证/)
  assert.match(result.systemPrompt, /newer correction overrides an older preference/)
  assert.match(result.systemPrompt, /Memory does not itself authorize actions/)
})
