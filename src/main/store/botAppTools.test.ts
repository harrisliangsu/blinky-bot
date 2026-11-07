import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CONNECTED_APP_TOOLS } from '../../shared/connectedAppTools.ts'
import { liveBotTools } from '../agent/botToolScope.ts'
import { mintGrant, grantForToken } from '../gateway/tokens.ts'

test('only the selected Bot gets durable app tools; its Agent inherits them, withdrawal revokes old grants, and concurrent edits survive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-bot-app-tools-')), previous = process.env.OPENBOT_DATA_DIR
  process.env.OPENBOT_DATA_DIR = root
  try {
    const api = await import('./bots.ts'), { flushAll } = await import('./jsonStore.ts'), { bindExecutionAgent, setExecutionAgent } = await import('../agent/executionAgent.ts')
    await api.loadBots()
    const selected = api.createBot({ name: 'Selected', tools: ['read_file', 'delegate_task'], computerUse: false }), other = api.createBot({ name: 'Other', tools: ['read_file'] })
    await flushAll()
    const revision = api.botToolsRevision(selected.id)
    const saving = api.setBotAppToolsDurable(selected.id, CONNECTED_APP_TOOLS.gmail, true, revision)
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    assert.equal(api.getBot(selected.id)!.tools.includes('search_gmail'), false, 'pending capabilities are not advertised')
    api.updateBot(selected.id, { description: 'A concurrent profile edit' })
    const saved = await saving
    assert.ok(CONNECTED_APP_TOOLS.gmail.every(id => saved.tools.includes(id)))
    assert.equal(saved.description, 'A concurrent profile edit')
    assert.ok(!api.getBot(other.id)!.tools.includes('read_gmail'))
    assert.ok(!saved.tools.includes('shell')); assert.ok(!saved.tools.includes('slack_message_draft'))
    const disk = JSON.parse(await readFile(join(root, 'bots', selected.id + '.json'), 'utf8'))
    assert.equal(disk.description, saved.description); assert.ok(disk.tools.includes('read_gmail'))
    setExecutionAgent('execution', { backendId: 'codex', modelId: 'fixture' }, selected.id)
    const executor = bindExecutionAgent('execution', saved)
    assert.ok(executor.tools.includes('read_gmail')); assert.ok(!executor.tools.includes('delegate_task'))
    assert.ok(!liveBotTools(selected.id, executor.tools).includes('delegate_task'), 'scope refresh never restores executor delegation')
    const grant = mintGrant({ botId: selected.id, sessionId: 'execution', tools: executor.tools, cwd: root, computerUse: false, computerTarget: { kind: 'local' } })
    await api.setBotAppToolsDurable(selected.id, CONNECTED_APP_TOOLS.gmail, false)
    assert.equal(grantForToken(grant.token), undefined)
    assert.ok(!liveBotTools(selected.id, saved.tools).includes('read_gmail'), 'an old local model snapshot cannot keep withdrawn access')
    const oldRevision = api.botToolsRevision(selected.id)
    api.updateBot(selected.id, { tools: ['read_file'] })
    await assert.rejects(api.setBotAppToolsDurable(selected.id, CONNECTED_APP_TOOLS.gmail, true, oldRevision), /permissions changed/)
    await flushAll()
    const file = join(root, 'bots', selected.id + '.json'), backup = file + '.preserved'
    await rename(file, backup); await mkdir(file)
    await assert.rejects(api.setBotAppToolsDurable(selected.id, CONNECTED_APP_TOOLS.gmail, true), /EISDIR|directory|rename/)
    assert.ok(!api.getBot(selected.id)!.tools.includes('read_gmail'))
    await rm(file, { recursive: true }); await rename(backup, file)
    assert.equal(api.getBot(other.id)!.name, 'Other')
  } finally { if (previous === undefined) delete process.env.OPENBOT_DATA_DIR; else process.env.OPENBOT_DATA_DIR = previous; await rm(root, { recursive: true, force: true }) }
})
