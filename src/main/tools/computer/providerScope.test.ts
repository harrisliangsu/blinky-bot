import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { getComputerProvider, releaseComputerProvidersForBot } from './index.ts'
import { profileLayout } from './browser/profile.ts'
import { browserFor, getBrowser, removeBrowser } from './browser/registry.ts'
import { browserScopeId } from './browserScope.ts'

test('provider instances follow session scope and never cross Bot ownership', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-provider-scope-'))
  const target = { kind: 'browser' as const, botId: 'provider-scope-test', provider: 'ego' as const }
  try {
    const options = { dataDir: root, botId: target.botId }
    const first = getComputerProvider(target, { ...options, sessionId: 'a' })
    assert.equal(getComputerProvider(target, { ...options, sessionId: 'a' }), first)
    assert.notEqual(getComputerProvider(target, { ...options, sessionId: 'b' }), first)
    assert.throws(() => getComputerProvider(target, { ...options }), /conversation id/)
    assert.throws(() => getComputerProvider(target, { ...options, botId: 'other', sessionId: 'a' }), /owner/)
  } finally { await releaseComputerProvidersForBot(target.botId); await rm(root, { recursive: true, force: true }) }
})

test('legacy providers retain their Bot-level identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-provider-legacy-'))
  const target = { kind: 'browser' as const, botId: 'provider-legacy-test', provider: 'ego' as const }
  try {
    await mkdir(profileLayout(target.botId, root).root, { recursive: true })
    const options = { dataDir: root, botId: target.botId }
    assert.equal(getComputerProvider(target, { ...options, sessionId: 'a' }), getComputerProvider(target, { ...options, sessionId: 'b' }))
  } finally { await releaseComputerProvidersForBot(target.botId); await rm(root, { recursive: true, force: true }) }
})

test('same Bot and session under separate data roots never share a provider or Chrome registry entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-provider-roots-'))
  const left = join(root, 'left'), right = join(root, 'right')
  const target = { kind: 'browser' as const, botId: 'provider-roots-test', provider: 'chrome' as const }
  try {
    const one = getComputerProvider(target, { dataDir: left, botId: target.botId, sessionId: 'same' })
    const two = getComputerProvider(target, { dataDir: right, botId: target.botId, sessionId: 'same' })
    assert.notEqual(one, two)
    assert.notEqual(browserFor('direct-test', { userDataDir: left }), browserFor('direct-test', { userDataDir: right }))
    await removeBrowser('direct-test', { userDataDir: left })
    await removeBrowser('direct-test', { userDataDir: right })
  } finally { await releaseComputerProvidersForBot(target.botId); await rm(root, { recursive: true, force: true }) }
})

test('releasing a bot stops only that exact owner and forgets its Chrome cache without deleting profiles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-provider-release-'))
  const firstId = 'bot', secondId = 'bot:other'
  const target = { kind: 'browser' as const, botId: firstId, provider: 'chrome' as const }
  try {
    const first = getComputerProvider(target, { dataDir: root, botId: firstId, sessionId: 'a' })
    const other = getComputerProvider({ ...target, botId: secondId, provider: 'ego' }, { dataDir: root, botId: secondId, sessionId: 'b' })
    let stopped = false
    ;(other as typeof other & { stop: () => Promise<void> }).stop = async () => { stopped = true }
    const scopeId = browserScopeId(firstId, 'a', root).id
    assert.equal(getBrowser(scopeId, root), first)
    await releaseComputerProvidersForBot(firstId)
    assert.equal(getBrowser(scopeId, root), undefined)
    assert.equal(stopped, false)
    assert.equal(getComputerProvider({ ...target, botId: secondId, provider: 'ego' }, { dataDir: root, botId: secondId, sessionId: 'b' }), other)
    assert.notEqual(getComputerProvider(target, { dataDir: root, botId: firstId, sessionId: 'a' }), first)
  } finally {
    await releaseComputerProvidersForBot(firstId)
    await releaseComputerProvidersForBot(secondId)
    await rm(root, { recursive: true, force: true })
  }
})
