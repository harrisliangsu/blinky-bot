import assert from 'node:assert/strict'
import { test } from 'node:test'
import { codexSafety } from './codexSafety.ts'

test('Codex auto-run uses sandboxed automatic review and keeps read-only and prompting modes separate', () => {
  assert.deepEqual(codexSafety({ approvalPolicy: 'auto-run' }), { approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'auto_review' })
  assert.deepEqual(codexSafety({ approvalPolicy: 'ask-every-time' }), { approvalPolicy: 'untrusted', sandbox: 'read-only', approvalsReviewer: 'user' })
  assert.deepEqual(codexSafety({ approvalPolicy: 'auto-run', restrictNativeWrites: true }), { approvalPolicy: 'never', sandbox: 'read-only', approvalsReviewer: 'user' })
  assert.deepEqual(codexSafety({ approvalPolicy: 'auto-run', readOnly: true }), { approvalPolicy: 'never', sandbox: 'read-only', approvalsReviewer: 'user' })
  assert.deepEqual(codexSafety({ approvalPolicy: 'auto-run', coordinatorOnly: true }), { approvalPolicy: 'on-request', sandbox: 'read-only', approvalsReviewer: 'user' })
})
