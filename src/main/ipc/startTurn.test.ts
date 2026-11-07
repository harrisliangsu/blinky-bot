import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startTurn } from './startTurn.ts'

test('acceptance returns while the agent is still working', async () => {
  let finish!: () => void
  const run = new Promise<void>((resolve) => { finish = resolve })
  let completed = false
  void run.then(() => { completed = true })
  assert.equal(startTurn(() => run, () => assert.fail('unexpected failure')), true)
  assert.equal(completed, false)
  finish()
  await run
  assert.equal(completed, true)
})

test('synchronous and asynchronous failures reach the error handler', async () => {
  const errors: string[] = []
  assert.equal(startTurn(() => { throw new Error('sync') }, (error) => errors.push((error as Error).message)), false)
  assert.equal(startTurn(() => Promise.reject(new Error('async')), (error) => errors.push((error as Error).message)), true)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.deepEqual(errors, ['sync', 'async'])
})
