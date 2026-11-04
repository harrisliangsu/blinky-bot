import assert from 'node:assert/strict'
import { test } from 'node:test'

import { grantCovers, targetScope, type Grant, type GrantInput } from './tokens.ts'

function grant(overrides: Partial<Grant> = {}): Grant {
  return {
    token: 'token',
    botId: 'bot',
    sessionId: 'session',
    cwd: '/work',
    tools: ['read_file', 'shell'],
    computerUse: false,
    computerTarget: { kind: 'local' },
    createdAt: 1,
    abort: new AbortController(),
    ...overrides
  }
}

function input(overrides: Partial<GrantInput> = {}): GrantInput {
  return {
    botId: 'bot',
    sessionId: 'session',
    cwd: '/work',
    tools: ['shell', 'read_file'],
    computerUse: false,
    computerTarget: { kind: 'local' },
    ...overrides
  }
}

test('an unchanged bot keeps its gateway grant', () => {
  assert.equal(grantCovers(grant(), input()), true)
})

test('a tool, directory, or computer change needs a new grant', () => {
  assert.equal(grantCovers(grant(), input({ tools: ['read_file'] })), false)
  assert.equal(grantCovers(grant(), input({ cwd: '/other' })), false)
  assert.equal(grantCovers(grant(), input({ computerUse: true })), false)
  assert.equal(
    grantCovers(
      grant(),
      input({ computerTarget: { kind: 'vm', vmId: 'vm-1', endpoint: 'http://127.0.0.1:1' } })
    ),
    false
  )
})

test('target scope ignores the VM bearer token', () => {
  const endpoint = 'http://127.0.0.1:1'
  assert.equal(
    targetScope({ kind: 'vm', vmId: 'vm-1', endpoint, token: 'a' }),
    targetScope({ kind: 'vm', vmId: 'vm-1', endpoint, token: 'b' })
  )
})
