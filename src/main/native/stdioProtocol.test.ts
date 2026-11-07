import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dispatchNativeFrame } from './stdioProtocol.ts'

test('native child dispatch accepts only its explicit channels', async () => {
  const handlers = new Map([
    ['openbot:bots:list', () => [{ id: 'bot-1' }]],
    ['openbot:window:close', () => { throw new Error('must not run') }]
  ])
  assert.deepEqual(JSON.parse(await dispatchNativeFrame('{"id":"1","channel":"openbot:bots:list","args":[]}', handlers)),
    { id: '1', result: [{ id: 'bot-1' }] })
  assert.equal(JSON.parse(await dispatchNativeFrame('{"id":"2","channel":"openbot:window:close","args":[]}', handlers)).error, 'Unsupported channel')
  assert.equal(JSON.parse(await dispatchNativeFrame('{"id":"3","channel":"openbot:bots:list","args":{}}', handlers)).error, 'Invalid arguments')
})
