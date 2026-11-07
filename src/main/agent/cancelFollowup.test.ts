import assert from 'node:assert/strict'
import { test } from 'node:test'
import { finish, isRunning, markRecorded, register, rejectedApprovalFor, start, stopAfterRejectedApproval, supersedeForFollowup } from './cancel.ts'

test('a follow-up waits for a recorded turn and its cleanup', () => {
  const controller = start('followup-test')
  assert.equal(supersedeForFollowup('followup-test'), false)
  assert.equal(controller.signal.aborted, false)
  markRecorded('followup-test', controller)
  assert.equal(supersedeForFollowup('followup-test'), true)
  assert.equal(controller.signal.aborted, true)
  assert.equal(isRunning('followup-test'), true)
  assert.equal(supersedeForFollowup('followup-test'), false)
  finish('followup-test', controller)
  assert.equal(isRunning('followup-test'), false)
})

test('rejecting an approval stops work but keeps session ownership until cleanup', () => {
  const controller=start('approval-test');let disposed=0
  register('approval-test',()=>{disposed++})
  assert.equal(stopAfterRejectedApproval('approval-test','rejected action'),true)
  assert.equal(controller.signal.aborted,true)
  assert.equal(disposed,1)
  assert.equal(isRunning('approval-test'),true)
  assert.equal(rejectedApprovalFor('approval-test',controller),'rejected action')
  assert.equal(rejectedApprovalFor('approval-test',new AbortController()),undefined)
  assert.equal(stopAfterRejectedApproval('approval-test'),false)
  finish('approval-test',controller)
  assert.equal(isRunning('approval-test'),false)
  assert.equal(rejectedApprovalFor('approval-test',controller),undefined)
})
