import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rename, mkdir, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSettings, updateSettings, saveVoiceLanguage } from './settings.ts'
import { flushAll } from './store/jsonStore.ts'
import { normaliseSettings } from './settingsSchema.ts'
const root = await mkdtemp(join(tmpdir(), 'blinky-voice-settings-'))
process.env.OPENBOT_DATA_DIR = root
const file = join(root, 'settings.json')
test('old settings retain system and custom locales, Chinese and English persist immediately', async () => {
  assert.equal(normaliseSettings({}).voiceLanguage, 'system')
  assert.equal(normaliseSettings({ voiceLanguage: 'ja-JP' }).voiceLanguage, 'ja-JP')
  assert.equal(normaliseSettings({ voiceLanguage: 'bad_locale' }).voiceLanguage, 'system')
  updateSettings({ theme: 'dark', profileName: 'Keep', denylist: ['keep'] }); await flushAll()
  for (const locale of ['zh-CN', 'en-US']) {
    assert.equal(await saveVoiceLanguage(locale), locale)
    const disk = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(disk.voiceLanguage, locale); assert.equal(disk.theme, 'dark'); assert.deepEqual(disk.denylist, ['keep'])
  }
  await assert.rejects(saveVoiceLanguage('bad_locale'))
  assert.equal(getSettings().voiceLanguage, 'en-US')
})
test('disk failure keeps the last saved language; repair and retry work', async () => {
  await rename(file, file + '.saved'); await mkdir(file)
  await assert.rejects(saveVoiceLanguage('zh-CN'))
  assert.equal(getSettings().voiceLanguage, 'en-US')
  await rmdir(file); await rename(file + '.saved', file)
  await saveVoiceLanguage('zh-CN')
  assert.equal(JSON.parse(await readFile(file, 'utf8')).voiceLanguage, 'zh-CN')
})
test('concurrent preferences and sequential language saves preserve both updates', async () => {
  const pending = saveVoiceLanguage('en-US')
  await new Promise<void>(resolve => setImmediate(resolve))
  updateSettings({ theme: 'light', profileName: 'New identity' })
  await pending; await flushAll()
  let disk = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(disk.theme, 'light'); assert.equal(disk.profileName, 'New identity'); assert.equal(disk.voiceLanguage, 'en-US')
  await Promise.all([saveVoiceLanguage('zh-CN'), saveVoiceLanguage('en-GB')])
  disk = JSON.parse(await readFile(file, 'utf8')); assert.equal(disk.voiceLanguage, 'en-GB')
})
