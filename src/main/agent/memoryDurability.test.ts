import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { addBotMemoryDurable, listBotMemory, loadMemory } from '../store/memory.ts'
import { rememberTool } from '../tools/agent/memory.ts'
import type { ToolContext } from '../tools/types.ts'

test('memory is durable before acknowledgement and unreadable data is not overwritten', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-memory-durable-'))
  const previous = process.env.OPENBOT_DATA_DIR
  process.env.OPENBOT_DATA_DIR = root
  try {
    await mkdir(join(root, 'memory'), { recursive: true })
    await writeFile(join(root, 'memory', 'broken.json'), '{invalid json')
    await loadMemory()
    await assert.rejects(addBotMemoryDurable('broken', 'remember this preference'), /refusing to overwrite/)
    assert.deepEqual(listBotMemory('broken'), [])
    const entry = await addBotMemoryDurable('good', '用户喜欢简体中文', 'user')
    const persisted = JSON.parse(await readFile(join(root, 'memory', 'good.json'), 'utf8'))
    assert.ok(persisted.entries.some((item: { id: string }) => item.id === entry.id))
  } finally {
    if (previous === undefined) delete process.env.OPENBOT_DATA_DIR
    else process.env.OPENBOT_DATA_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('remember tool reports a rejected or failed save rather than inventing success', async () => {
  const ctx: ToolContext = { sessionId: 's', botId: 'b', cwd: '/tmp', signal: new AbortController().signal, requestApproval: async () => true, emit: () => {}, host: { saveMemory: async () => ({ entry: null, reason: 'memory could not be saved' }) } }
  const failed = await rememberTool.handler({ text: '用户喜欢简体中文' }, ctx)
  assert.equal(failed.ok, false)
  assert.match(failed.output, /could not be saved/)
  ctx.host!.saveMemory = async () => ({ entry: null, reason: 'already remembered' })
  const duplicate = await rememberTool.handler({ text: '用户喜欢简体中文' }, ctx)
  assert.equal(duplicate.ok, true)
  assert.equal(duplicate.output, 'already remembered')
})
