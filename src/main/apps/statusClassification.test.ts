import assert from 'node:assert/strict'
import test from 'node:test'
import { githubProbeState, gitProbeFailed } from './statusClassification'

test('GitHub distinguishes no login from network or invalid authentication', () => {
  assert.equal(githubProbeState({ ok: true, stdout: '', stderr: 'Logged in to github.com' }), 'connected')
  assert.equal(githubProbeState({ ok: false, stdout: '', stderr: 'You are not logged into any GitHub hosts. Run gh auth login to authenticate.' }), 'disconnected')
  assert.equal(githubProbeState({ ok: false, stdout: '', stderr: 'network timeout', code: 1 }), 'unavailable')
  assert.equal(githubProbeState({ ok: false, stdout: '', stderr: 'Failed to log in to github.com account', code: 1 }), 'unavailable')
  assert.equal(githubProbeState({ ok: false, stdout: '', stderr: '' }), 'unavailable')
})

test('Git missing config differs from a failed read', () => {
  assert.equal(gitProbeFailed({ ok: false, stdout: '', stderr: '', code: 1 }), false)
  assert.equal(gitProbeFailed({ ok: false, stdout: '', stderr: 'permission denied', code: 128 }), true)
  assert.equal(gitProbeFailed({ ok: false, stdout: '', stderr: '' }), true)
  assert.equal(gitProbeFailed({ ok: true, stdout: 'name', stderr: '' }), false)
})
