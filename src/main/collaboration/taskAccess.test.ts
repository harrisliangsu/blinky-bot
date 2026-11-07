import assert from 'node:assert/strict'
import { test } from 'node:test'
import { taskVisibleInRoom } from './taskAccess.ts'

test('room task access follows the approved source or execution conversation, never merely the same Bot', () => {
  assert.equal(taskVisibleInRoom({ sessionId: 'execution', sourceSessionId: 'room' }, 'room'), true)
  assert.equal(taskVisibleInRoom({ sessionId: 'room', sourceSessionId: 'other-source' }, 'room'), true)
  assert.equal(taskVisibleInRoom({ sessionId: 'other-execution', sourceSessionId: 'other-source' }, 'room'), false)
  assert.equal(taskVisibleInRoom({ sessionId: 'legacy-other' }, 'room'), false)
  assert.equal(taskVisibleInRoom(null, 'room'), false)
})
