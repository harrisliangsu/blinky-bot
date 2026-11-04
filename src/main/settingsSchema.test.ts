/**
 * Settings coercion. Every new preference has to survive a save/load
 * and reject a value the renderer is not allowed to invent.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { backendFieldPlan, cliIsListed, listedBackends, orderedBackendSections, providerIsListed } from '../shared/backendSections.ts'
import { copyLeaves, settingsCopy } from '../renderer/src/lib/settingsCopy.ts'
import { defaultSettings, normaliseSettings } from './settingsSchema.ts'
import { compareVersions, decideUpdate, isNewer, pickRelease, readSparkleItem } from './updates/sparkleFeed.ts'

test('Chinese and English settings describe the same controls', () => {
  const english = copyLeaves(settingsCopy('en')).sort()
  const chinese = copyLeaves(settingsCopy('zh-CN')).sort()
  assert.deepEqual(chinese, english)
  assert.ok(english.length > 40)
})

test('backends settings separate providers from local CLIs, and bots are not assistants', () => {
  const zh = settingsCopy('zh-CN')
  const en = settingsCopy('en')
  assert.equal(zh.nav.bots, 'Bot')
  assert.equal(en.nav.bots, 'Bots')
  assert.equal(zh.more.bots, 'Bot')
  assert.equal(zh.general.steps, '显示 Bot 步骤')
  assert.equal(en.general.steps, 'Show bot steps')
  assert.equal(zh.backends.localCli, '本地 CLI')
  assert.equal(zh.backends.providers, '供应商')
  assert.equal(en.backends.providers, 'Providers')
  assert.equal(zh.backends.addCli, '添加')
  assert.equal(en.backends.addCli, 'Add')
  assert.equal(zh.backends.cliEmpty, '还没有可用的 CLI。')
  assert.equal(zh.backends.providersEmpty, '还没有添加供应商')
  assert.equal(zh.backends.providersEmptyHint, '添加后可使用云端 API Key / Base URL')
  assert.equal(zh.backends.manage, '管理')
  assert.equal(zh.more.search, '搜索 Bot')
  assert.equal('localCliHint' in zh.backends, false)
  assert.equal('providersHint' in zh.backends, false)
  assert.equal('compatibleHint' in zh.backends, false)
  assert.equal('title' in zh.more, false)
  assert.equal(JSON.stringify(zh.backends).includes('OpenRouter'), false)
  assert.equal(JSON.stringify(zh).includes('助手'), false)
  assert.equal(JSON.stringify(en).toLowerCase().includes('assistant'), false)

  const sections = orderedBackendSections([
    { id: 'opencode', kind: 'agent-cli' as const },
    { id: 'openai', kind: 'cloud-api' as const },
    { id: 'claude', kind: 'agent-cli' as const },
    { id: 'ollama', kind: 'local-server' as const },
    { id: 'openrouter', kind: 'cloud-api' as const }
  ])
  assert.deepEqual(
    sections.map((section) => section.id),
    ['provider', 'cli']
  )
  assert.deepEqual(
    sections[0]?.items.map((item) => item.id),
    ['openai', 'ollama', 'openrouter']
  )
  assert.deepEqual(
    sections[1]?.items.map((item) => item.id),
    ['opencode', 'claude']
  )

  assert.deepEqual(backendFieldPlan({ id: 'claude', kind: 'agent-cli' }, false), {
    command: true,
    baseUrl: false,
    apiKey: false,
    apiKeyOptional: false
  })
  assert.equal(backendFieldPlan({ id: 'grok', kind: 'agent-cli' }, false).apiKey, true)
  assert.equal(backendFieldPlan({ id: 'opencode', kind: 'agent-cli' }, true).apiKey, true)
  assert.equal(backendFieldPlan({ id: 'kimi', kind: 'agent-cli' }, false).apiKey, false)
  const provider = backendFieldPlan({ id: 'openai', kind: 'cloud-api' }, false)
  assert.equal(provider.apiKey, true)
  assert.equal(provider.baseUrl, true)
  assert.equal(provider.command, false)
})

test('cloud providers stay hidden until added, and a saved key lists them', () => {
  const settings = defaultSettings()
  assert.equal(settings.backends.openai?.added, false)
  assert.equal(settings.backends.opencode?.added, undefined)
  assert.equal(providerIsListed(settings.backends.openai), false)
  const withKey = normaliseSettings({
    backends: { openai: { enabled: true, hasApiKey: true, baseUrl: 'https://api.openai.com/v1' } }
  })
  assert.equal(withKey.backends.openai?.added, true)
  assert.equal(providerIsListed(withKey.backends.openai), true)
  const removed = normaliseSettings({
    backends: { openai: { enabled: false, added: false, hasApiKey: true, baseUrl: 'https://api.openai.com/v1' } }
  })
  assert.equal(removed.backends.openai?.added, false)
  const rows = [
    { id: 'openai', kind: 'cloud-api' as const },
    { id: 'codex', kind: 'agent-cli' as const, status: 'available' as const, cliAuth: { state: 'logged-in' as const } }
  ]
  assert.deepEqual(listedBackends(rows, settings.backends).map((row) => row.id), ['codex'])
  assert.deepEqual(listedBackends(rows, withKey.backends).map((row) => row.id), ['openai', 'codex'])
  const hidden = [{ id: 'kimi', kind: 'agent-cli' as const, status: 'not-installed' }]
  assert.equal(cliIsListed(hidden[0], settings.backends.kimi), false)
  assert.deepEqual(listedBackends(hidden, settings.backends).map((row) => row.id), [])
  assert.deepEqual(
    listedBackends(hidden, { kimi: { added: true } }).map((row) => row.id),
    ['kimi']
  )
})

test('local CLIs stay off the default list until signed in or explicitly added', () => {
  const settings = defaultSettings()
  const rows = [
    { id: 'codex', kind: 'agent-cli' as const, status: 'available' as const, cliAuth: { state: 'logged-in' as const } },
    { id: 'claude', kind: 'agent-cli' as const, status: 'not-installed' as const, cliAuth: { state: 'not-installed' as const } },
    { id: 'opencode', kind: 'agent-cli' as const, status: 'not-installed' as const },
    { id: 'kimi', kind: 'agent-cli' as const, status: 'needs-key' as const, cliAuth: { state: 'logged-out' as const } },
    { id: 'grok', kind: 'agent-cli' as const, status: 'error' as const, cliAuth: { state: 'unknown' as const } }
  ]
  assert.equal(cliIsListed(rows[1], settings.backends.claude), false)
  assert.equal(cliIsListed(rows[3], settings.backends.kimi), false)
  assert.deepEqual(
    listedBackends(rows, settings.backends).map((row) => row.id),
    ['codex']
  )
  const added = normaliseSettings({
    backends: { claude: { enabled: true, added: true, command: 'claude' } }
  })
  assert.equal(added.backends.claude?.added, true)
  assert.deepEqual(
    listedBackends(rows, added.backends).map((row) => row.id),
    ['codex', 'claude']
  )
  const removed = normaliseSettings({
    backends: { claude: { enabled: true, added: false, command: 'claude' } }
  })
  assert.deepEqual(
    listedBackends(rows, removed.backends).map((row) => row.id),
    ['codex']
  )
})

test('defaults include the settings the window actually shows', () => {
  const settings = defaultSettings()
  assert.equal(settings.language, 'zh-CN')
  assert.equal(settings.uiScale, 100)
  assert.equal(settings.vibrant, false)
  assert.equal(settings.sendShortcut, 'enter')
  assert.equal(settings.expandSteps, false)
  assert.equal(settings.linkOpen, 'browser')
  assert.equal(settings.launchAtLogin, false)
  assert.equal(settings.notifications, true)
  assert.equal(settings.notifyOnTurn, false)
  assert.equal(settings.updateChannel, 'stable')
  assert.equal(settings.accent, 'theme')
  assert.equal(settings.telemetry, false)
})

test('a partial save keeps the new fields and drops unknown ones', () => {
  const saved = normaliseSettings({
    language: 'en',
    uiScale: 125,
    vibrant: true,
    accent: 'purple',
    sendShortcut: 'mod-enter',
    expandSteps: true,
    linkOpen: 'window',
    launchAtLogin: true,
    runInBackground: true,
    profileName: '  Ada  ',
    profileEmoji: '✨',
    profileColor: '#5ad1a5',
    notifications: false,
    notifyOnTurn: true,
    updateChannel: 'beta',
    theme: 'dark',
    notASetting: 'nope'
  })
  assert.equal(saved.language, 'en')
  assert.equal(saved.uiScale, 125)
  assert.equal(saved.vibrant, true)
  assert.equal(saved.accent, 'purple')
  assert.equal(saved.sendShortcut, 'mod-enter')
  assert.equal(saved.expandSteps, true)
  assert.equal(saved.linkOpen, 'window')
  assert.equal(saved.launchAtLogin, true)
  assert.equal(saved.runInBackground, true)
  assert.equal(saved.profileName, 'Ada')
  assert.equal(saved.profileEmoji, '✨')
  assert.equal(saved.profileColor, '#5ad1a5')
  assert.equal(saved.notifications, false)
  assert.equal(saved.notifyOnTurn, true)
  assert.equal(saved.updateChannel, 'beta')
  assert.equal(saved.theme, 'dark')
  assert.equal('notASetting' in saved, false)
  const again = normaliseSettings(saved)
  assert.deepEqual(again, saved)
})

test('illegal values fall back instead of being stored', () => {
  const saved = normaliseSettings({
    language: 'fr',
    uiScale: 73,
    accent: 'neon',
    sendShortcut: 'shift-enter',
    linkOpen: 'mail',
    updateChannel: 'nightly',
    profileColor: 'red',
    notifications: 'yes'
  })
  assert.equal(saved.language, 'zh-CN')
  assert.equal(saved.uiScale, 100)
  assert.equal(saved.accent, 'theme')
  assert.equal(saved.sendShortcut, 'enter')
  assert.equal(saved.linkOpen, 'browser')
  assert.equal(saved.updateChannel, 'stable')
  assert.equal(saved.profileColor, '#7c9cff')
  assert.equal(saved.notifications, true)
})

test('an old file that only set run-in-background still starts at login', () => {
  const saved = normaliseSettings({ runInBackground: true })
  assert.equal(saved.launchAtLogin, true)
  assert.equal(saved.runInBackground, true)
  const explicit = normaliseSettings({ runInBackground: true, launchAtLogin: false })
  assert.equal(explicit.launchAtLogin, false)
})

test('sparkle feed parsing and version order', () => {
  const xml = `<?xml version="1.0"?>
    <item>
      <sparkle:shortVersionString>0.3.0</sparkle:shortVersionString>
      <enclosure url="https://example.com/BlinkyBot-0.3.0.zip" sparkle:edSignature="abc" />
    </item>`
  const item = readSparkleItem(xml)
  assert.deepEqual(item, { version: '0.3.0', url: 'https://example.com/BlinkyBot-0.3.0.zip' })
  assert.equal(isNewer('0.3.0', '0.2.2'), true)
  assert.equal(isNewer('0.2.2', '0.2.2'), false)
  assert.equal(compareVersions('0.2.10', '0.2.9'), 1)
  const decision = decideUpdate('0.2.2', item, 'empty')
  assert.equal(decision.updateAvailable, true)
  assert.equal(decideUpdate('0.3.0', item, 'empty').updateAvailable, false)
  assert.equal(decideUpdate('0.3.0', null, 'No beta release is published.').note, 'No beta release is published.')
})

test('beta picks a prerelease and stable does not', () => {
  const releases = [
    { version: '0.4.0-beta.1', url: 'https://example.com/beta', prerelease: true },
    { version: '0.3.0', url: 'https://example.com/stable', prerelease: false }
  ]
  assert.equal(pickRelease(releases, 'beta')?.version, '0.4.0-beta.1')
  assert.equal(pickRelease(releases, 'stable')?.version, '0.3.0')
  assert.equal(pickRelease([{ version: '0.3.0', url: 'x', prerelease: false }], 'beta'), null)
})
