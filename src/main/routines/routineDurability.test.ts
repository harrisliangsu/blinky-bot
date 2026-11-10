import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRoutineDurable, listRoutines, updateRoutineDurable } from '../store/routines.ts'
import { flushAll } from '../store/jsonStore.ts'

test('scheduled instructions are durable before acknowledgement and failed writes do not enter the cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-routine-durable-'))
  const previous = process.env['OPENBOT_DATA_DIR']
  try {
    process.env['OPENBOT_DATA_DIR'] = root
    const routine = await createRoutineDurable({ botId: 'bot', name: 'daily', instruction: 'do work', trigger: { kind: 'schedule', cron: '0 8 * * *' } })
    const saved = JSON.parse(await readFile(join(root, 'routines', `${routine.id}.json`), 'utf8')) as { instruction: string }
    assert.equal(saved.instruction, 'do work')
    await flushAll()
    const blocked = join(root, 'not-a-directory')
    await writeFile(blocked, 'fixture')
    process.env['OPENBOT_DATA_DIR'] = blocked
    await assert.rejects(createRoutineDurable({ botId: 'bot', name: 'must not exist', instruction: 'work' }))
    assert.ok(!listRoutines().some((item) => item.name === 'must not exist'))
    await assert.rejects(updateRoutineDurable(routine.id, { instruction: 'unsaved update' }))
    assert.equal(listRoutines().find((item) => item.id === routine.id)?.instruction, 'do work')
  } finally {
    if (previous === undefined) delete process.env['OPENBOT_DATA_DIR']
    else process.env['OPENBOT_DATA_DIR'] = previous
    await rm(root, { recursive: true, force: true })
  }
})

test('first creation and later status patches preserve the same canonical routine definition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-routine-canonical-'))
  const previous = process.env['OPENBOT_DATA_DIR']
  try {
    process.env['OPENBOT_DATA_DIR'] = root
    const triggers = [
      { kind: 'once', at: 1793988480000, lateMinutes: 1 },
      { kind: 'once', at: 1793988480000 },
      { kind: 'folder_change', path: root },
      { kind: 'schedule', lateMinutes: 2, earlyMinutes: 1, tz: 'Asia/Shanghai', cron: '0 8 * * *' },
      { kind: 'schedule', cron: '0 8 * * *' }
    ] as const
    const definition = (routine: NonNullable<ReturnType<typeof listRoutines>[number]>) => JSON.stringify([routine.botId, routine.trigger, routine.instruction, routine.steps, routine.replayMode])
    for (const trigger of triggers) {
      const routine = await createRoutineDurable({ botId: 'bot', instruction: 'Canonical fixture', trigger: { ...trigger } })
      const before = definition(routine)
      const updated = await updateRoutineDurable(routine.id, { lastRunAt: 1, lastRunState: 'claimed' })
      assert.ok(updated)
      assert.equal(definition(updated), before, 'A status-only update must not look like a concurrent definition edit: ' + trigger.kind)
      assert.deepEqual(updated.trigger, trigger, 'Optional schedule fields must survive normalization')
      const saved = JSON.parse(await readFile(join(root, 'routines', `${routine.id}.json`), 'utf8'))
      assert.equal(definition(saved), before)
    }
    await flushAll()
  } finally {
    if (previous === undefined) delete process.env['OPENBOT_DATA_DIR']
    else process.env['OPENBOT_DATA_DIR'] = previous
    await rm(root, { recursive: true, force: true })
  }
})
