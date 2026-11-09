import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { capturePlanExperience, planExperienceReferences } from './planExperience'
import { parseTaskPlan } from './planning'

const root = (): string => process.env['OPENBOT_DATA_DIR'] as string
const mkTask = (id: string, title: string, status = 'completed', blocked = false) => ({
  id, botId: 'bot', sessionId: 'exec-' + id, title, prompt: 'p', status: status as 'completed',
  createdAt: 1, updatedAt: 2,
  ...(blocked ? { review: { outcome: 'blocked' as const, summary: 's', evidence: ['e'], recordedAt: 3 } } : {}),
  plan: parseTaskPlan({ context: { summary: 'p', categories: ['功能开发'], scope: ['src/export'], boundaries: ['不发布'] } }, root(), 'home', 'bot', [])
})

test('completed tasks teach the experience store and blocked outcomes never do', async () => {
  process.env['OPENBOT_DATA_DIR'] = await mkdtemp(join(tmpdir(), 'blinky-exp-'))
  try {
    await capturePlanExperience(mkTask('t-1', '报表导出加打印样式'))
    await capturePlanExperience(mkTask('t-2', '账号安全增强短信验证', 'completed', true))
    await capturePlanExperience(mkTask('t-1', '报表导出加打印样式'))
    const refs = await planExperienceReferences('报表系统新增 PDF 导出功能')
    assert.equal(refs.length, 1)
    assert.equal(refs[0].title, '报表导出加打印样式')
    assert.deepEqual(refs[0].scope, ['src/export'])
  } finally {
    await rm(process.env['OPENBOT_DATA_DIR'] as string, { recursive: true, force: true })
    delete process.env['OPENBOT_DATA_DIR']
  }
})

test('references require an actual similarity and stay within the envelope budget', async () => {
  process.env['OPENBOT_DATA_DIR'] = await mkdtemp(join(tmpdir(), 'blinky-exp2-'))
  try {
    await capturePlanExperience(mkTask('t-1', '报表导出加打印样式'))
    assert.equal((await planExperienceReferences('完全无关的量子物理论文翻译')).length, 0)
    const many = await planExperienceReferences('导出 报表 打印')
    assert.ok(JSON.stringify(many).length <= 1000)
  } finally {
    await rm(process.env['OPENBOT_DATA_DIR'] as string, { recursive: true, force: true })
    delete process.env['OPENBOT_DATA_DIR']
  }
})
