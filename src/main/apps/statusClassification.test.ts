import assert from 'node:assert/strict'
import test from 'node:test'
import { gitProbeFailed } from './statusClassification'

test('Git missing config differs from a failed read', () => {
  assert.equal(gitProbeFailed({ ok: false, stdout: '', stderr: '', code: 1 }), false)
  assert.equal(gitProbeFailed({ ok: false, stdout: '', stderr: 'permission denied', code: 128 }), true)
  assert.equal(gitProbeFailed({ ok: false, stdout: '', stderr: '' }), true)
  assert.equal(gitProbeFailed({ ok: true, stdout: 'name', stderr: '' }), false)
})
