import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

test('explicit memory kinds and shared provenance survive restart without reclassifying legacy notes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-memory-kinds-'))
  const run = code => {
    const result = spawnSync(process.execPath, ['--experimental-transform-types', '--import', resolve('scripts/register-ts.mjs'), '--input-type=module', '-e',
      `import * as m from ${JSON.stringify(pathToFileURL(resolve('src/main/store/memory.ts')).href)}; await m.loadMemory(); ${code}`],
      { env: { ...process.env, OPENBOT_DATA_DIR: root }, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout.trim().split('\n').at(-1))
  }
  try {
    run(`await m.writeUserMemory('a','保留旧笔记的类别'); await m.writeUserMemory('a','偏好简洁中文回复',undefined,'profile-1',true,'profile'); await m.writeUserMemory('a','今天完成临时目录检查',undefined,'journal-1',false,'journal'); console.log('true')`)
    const entries = run(`console.log(JSON.stringify(m.listBotMemory('a')))`)
    const legacy = entries.find(entry => entry.text === '保留旧笔记的类别')
    assert.ok(!legacy.tags?.includes('profile') && !legacy.tags?.includes('journal'))
    const profile = entries.find(entry => entry.text === '偏好简洁中文回复')
    assert.ok(profile.tags.includes('profile') && profile.tags.includes('source:bot:a'))
    const journal = entries.find(entry => entry.text === '今天完成临时目录检查')
    assert.ok(journal.tags.includes('journal'))
    run(`await m.writeUserMemory('a','今天完成临时目录检查',${JSON.stringify(journal.id)},'recategorize',false,'profile'); console.log('true')`)
    const updated = run(`console.log(JSON.stringify(m.listBotMemory('a').find(entry=>entry.text==='今天完成临时目录检查')))`)
    assert.ok(updated.tags.includes('profile') && !updated.tags.includes('journal'))
    assert.ok(run(`console.log(JSON.stringify(m.listBotMemory('b')))` ).some(entry => entry.id === profile.id))
  } finally { await rm(root, { recursive: true, force: true }) }
})
