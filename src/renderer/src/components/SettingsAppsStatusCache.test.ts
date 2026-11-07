import assert from 'node:assert/strict'
import test from 'node:test'
import { readLastAppStatuses, saveLastAppStatuses } from './SettingsAppsStatusCache'

test('status cache survives reopening without storing account or credentials', () => {
  let data = ''
  const storage = { getItem: () => data || null, setItem: (_key: string, value: string) => { data = value } }
  saveLastAppStatuses(storage, [
    { id: 'github', status: 'connected', account: 'account-name', detail: 'private' },
    { id: 'gmail', status: 'disconnected' }
  ])
  assert.deepEqual(readLastAppStatuses(storage), [{ id: 'github', status: 'connected' }, { id: 'gmail', status: 'disconnected' }])
  assert.ok(!data.includes('account-name') && !data.includes('private'))
  // A transient failure must not erase the last known result.
  saveLastAppStatuses(storage, [{ id: 'github', status: 'unavailable', detail: 'verification-failed' }])
  assert.equal(readLastAppStatuses(storage)[0].status, 'connected')
  saveLastAppStatuses(storage, [{ id: 'github', status: 'disconnected' }])
  assert.equal(readLastAppStatuses(storage)[0].status, 'disconnected')
})

test('malformed, unrecognised, and inaccessible cache is ignored', () => {
  const bad = { getItem: () => '[{"id":"github","status":"connected","account":"ignored"},{"id":"evil","status":"connected"},{"id":"x","status":"pending"}]', setItem: () => {} }
  assert.deepEqual(readLastAppStatuses(bad), [{ id: 'github', status: 'connected' }])
  const inaccessible = { getItem: () => { throw new Error('unavailable') }, setItem: () => { throw new Error('unavailable') } }
  assert.deepEqual(readLastAppStatuses(inaccessible), [])
  assert.doesNotThrow(() => saveLastAppStatuses(inaccessible, [{ id: 'git', status: 'connected' }]))
})
