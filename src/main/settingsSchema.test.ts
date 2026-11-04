/**
 * Settings coercion. Every new preference has to survive a save/load
 * and reject a value the renderer is not allowed to invent.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { copyLeaves, settingsCopy } from '../renderer/src/lib/settingsCopy.ts'
import { defaultSettings, normaliseSettings } from './settingsSchema.ts'
import { compareVersions, decideUpdate, isNewer, pickRelease, readSparkleItem } from './updates/sparkleFeed.ts'

test('Chinese and English settings describe the same controls', () => {
  const english = copyLeaves(settingsCopy('en')).sort()
  const chinese = copyLeaves(settingsCopy('zh-CN')).sort()
  assert.deepEqual(chinese, english)
  assert.ok(english.length > 40)
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
