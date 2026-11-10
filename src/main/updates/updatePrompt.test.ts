/**
 * The update offer: notify, ask to download and install, and refuse a zip
 * whose Sparkle signature does not match. No window and no network.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Readable } from 'node:stream'
import nacl from 'tweetnacl'
import { updateCopy } from './copy.ts'
import { downloadReleaseArchive, isAllowedDownloadUrl, isBlinkyReleaseArchive, isBlinkyReleasePage, type ArchiveResponse } from './download.ts'
import { acceptDownloadedArchive, canInstallOver, findExtractedApp, INSTALL_HELPER, installArguments, runningAppBundle } from './install.ts'
import { presentUpdate, type UpdatePresenter } from './present.ts'
import {
  canInstallArchive,
  emptyReminder,
  promptButtons,
  promptChoice,
  UPDATE_CHECK_INTERVAL_MS,
  type Reminder,
  type UpdateCandidate
} from './prompt.ts'
import { readReminder, writeReminder } from './reminders.ts'
import { isEd25519PublicKey, isEd25519Signature, SPARKLE_PUBLIC_KEY, verifySparkleSignature } from './signature.ts'
import { readSparkleItem } from './sparkleFeed.ts'
import { updateStatusText, settingsCopy } from '../../renderer/src/lib/settingsCopy.ts'

const ZIP = 'https://github.com/harrisliangsu/blinky-bot/releases/download/v0.9.0/BlinkyBot-0.9.0.zip'
const PAGE = 'https://github.com/harrisliangsu/blinky-bot/releases/tag/v0.9.0-beta.1'

function signature(bytes: Uint8Array, secret: Uint8Array): string {
  return Buffer.from(nacl.sign.detached(bytes, secret)).toString('base64')
}

const pair = nacl.sign.keyPair()
const signedBytes = new Uint8Array([1, 2, 3, 4])
const goodSignature = signature(signedBytes, pair.secretKey)

function candidate(patch: Partial<UpdateCandidate> = {}): UpdateCandidate {
  return {
    status: 'update',
    channel: 'stable',
    current: '0.3.13',
    latest: '0.9.0',
    url: ZIP,
    updateAvailable: true,
    note: '0.9.0 is available.',
    edSignature: goodSignature,
    length: signedBytes.byteLength,
    notes: '• A signed build.',
    ...patch
  }
}

function harness(responses: number[]) {
  const notices: string[] = []
  const told: Array<{ title: string; message: string }> = []
  const downloaded: UpdateCandidate[] = []
  const opened: string[] = []
  let asks = 0
  let reminder: Reminder = emptyReminder()
  let now = 1_000_000
  let click: (() => Promise<void> | void) | undefined
  let installResult: { ok: boolean; message: string; remind?: 'later' } = { ok: true, message: '' }
  const presenter: UpdatePresenter = {
    now: () => now,
    loadReminder: async () => reminder,
    saveReminder: async (next) => {
      reminder = next
    },
    notify(title, _body, onClick) {
      notices.push(title)
      click = onClick
    },
    ask: async () => {
      asks += 1
      return responses.shift() ?? 1
    },
    tell: async (title, message) => {
      told.push({ title, message })
    },
    openExternal: async (url) => {
      opened.push(url)
    },
    downloadAndInstall: async (update) => {
      downloaded.push(update)
      return installResult
    }
  }
  return {
    presenter,
    notices,
    told,
    downloaded,
    opened,
    asks: () => asks,
    reminder: () => reminder,
    setReminder: (next: Reminder) => {
      reminder = next
    },
    setNow: (value: number) => {
      now = value
    },
    setInstallResult: (result: { ok: boolean; message: string; remind?: 'later' }) => {
      installResult = result
    },
    click: () => click?.()
  }
}

test('a scheduled newer signed build notifies and the first dialog button installs', async () => {
  const ui = harness([0])
  const update = candidate()
  await presentUpdate('scheduled', update, ui.presenter, 'en')
  assert.deepEqual(promptButtons('install'), ['install', 'later', 'skip'])
  assert.equal(ui.notices[0], 'BlinkyBot 0.9.0 is available')
  assert.equal(ui.notices[1], 'Downloading BlinkyBot 0.9.0…')
  assert.equal(ui.downloaded.length, 1)
  assert.equal(ui.told.length, 0)
  assert.equal(ui.reminder().skippedVersion, null)
})

test('the same offer is in Chinese, and Later or Skip is what the dialog remembers', async () => {
  const later = harness([1])
  await presentUpdate('scheduled', candidate(), later.presenter, 'zh-CN')
  assert.equal(later.notices[0], 'BlinkyBot 0.9.0 可以更新')
  assert.equal(later.reminder().laterUntil, 1_000_000 + UPDATE_CHECK_INTERVAL_MS)
  assert.equal(later.downloaded.length, 0)

  const skipped = harness([2])
  await presentUpdate('manual', candidate(), skipped.presenter, 'en')
  assert.equal(skipped.reminder().skippedVersion, '0.9.0')
  assert.equal(promptChoice(['install', 'later', 'skip'], 99), 'later')
})

test('a scheduled check stays quiet after Later or Skip, and Check now still asks', async () => {
  const held = harness([0])
  held.setReminder({ skippedVersion: null, laterUntil: 5_000_000 })
  await presentUpdate('scheduled', candidate(), held.presenter, 'en')
  assert.equal(held.asks(), 0)
  assert.equal(held.notices.length, 0)

  held.setNow(5_000_000)
  await presentUpdate('scheduled', candidate(), held.presenter, 'en')
  assert.equal(held.asks(), 1)

  const skipped = harness([0])
  skipped.setReminder({ skippedVersion: '0.9.0', laterUntil: null })
  await presentUpdate('scheduled', candidate(), skipped.presenter, 'en')
  assert.equal(skipped.asks(), 0)
  await presentUpdate('manual', candidate(), skipped.presenter, 'en')
  assert.equal(skipped.asks(), 1)

  const newer = harness([1])
  newer.setReminder({ skippedVersion: '0.9.0', laterUntil: null })
  await presentUpdate('scheduled', candidate({ latest: '0.9.1' }), newer.presenter, 'en')
  assert.equal(newer.asks(), 1)
})

test('clicking the notification opens the offer again after Later', async () => {
  const ui = harness([1, 2])
  await presentUpdate('scheduled', candidate(), ui.presenter, 'en')
  assert.equal(ui.reminder().laterUntil !== null, true)
  await ui.click()
  assert.equal(ui.asks(), 2)
  assert.equal(ui.reminder().skippedVersion, '0.9.0')
  assert.equal(ui.notices.length, 1)
})

test('Check now reports up to date, an empty feed, or a failure, and a scheduled check does not', async () => {
  const current = harness([])
  await presentUpdate('manual', candidate({ status: 'current', updateAvailable: false, latest: '0.3.13' }), current.presenter, 'en')
  assert.equal(current.told[0]?.title, 'You’re up to date')
  assert.match(current.told[0]?.message ?? '', /0\.3\.13/)
  assert.equal(current.notices.length, 0)
  await presentUpdate('scheduled', candidate({ status: 'current', updateAvailable: false }), current.presenter, 'en')
  assert.equal(current.told.length, 1)

  const empty = harness([])
  await presentUpdate('manual', candidate({ status: 'empty', channel: 'beta', updateAvailable: false, latest: null, url: null }), empty.presenter, 'zh-CN')
  assert.equal(empty.told[0]?.message, '还没有测试版。')

  const failed = harness([])
  await presentUpdate('manual', candidate({ status: 'error', updateAvailable: false, latest: null, note: 'HTTP 503' }), failed.presenter, 'en')
  assert.equal(failed.told[0]?.title, 'Could not check for updates')
  assert.equal(failed.told[0]?.message, 'HTTP 503')
  await presentUpdate('scheduled', candidate({ status: 'error', updateAvailable: false, latest: null, note: 'HTTP 503' }), failed.presenter, 'en')
  assert.equal(failed.told.length, 1)
})

test('a beta page is a dialog that opens the release, and a failed install is shown', async () => {
  const beta = harness([0])
  const update = candidate({
    channel: 'beta',
    url: PAGE,
    edSignature: null,
    length: null,
    latest: '0.9.0-beta.1'
  })
  assert.equal(canInstallArchive(update), false)
  await presentUpdate('manual', update, beta.presenter, 'en')
  assert.deepEqual(beta.opened, [PAGE])
  assert.equal(beta.downloaded.length, 0)

  const broken = harness([0])
  broken.setInstallResult({ ok: false, message: 'disk full' })
  await presentUpdate('manual', candidate(), broken.presenter, 'en')
  assert.equal(broken.told.at(-1)?.title, 'The update could not be installed')
  assert.equal(broken.told.at(-1)?.message, 'disk full')

  const deferred = harness([0])
  deferred.setInstallResult({ ok: true, message: '', remind: 'later' })
  await presentUpdate('manual', candidate(), deferred.presenter, 'en')
  assert.equal(deferred.reminder().laterUntil, 1_000_000 + UPDATE_CHECK_INTERVAL_MS)
})

test('settings copy describes the offer in both languages', () => {
  const en = settingsCopy('en').updates
  const zh = settingsCopy('zh-CN').updates
  assert.match(en.hint, /download and install/i)
  assert.match(zh.hint, /下载安装/)
  assert.equal(en.install, 'Download and Install')
  assert.equal(zh.install, '下载并安装')
  assert.equal(updateStatusText({ status: 'update', channel: 'stable', current: '0.3.13', latest: '0.9.0', note: 'English' }, zh), '0.9.0 可以更新。')
  assert.equal(updateStatusText({ status: 'current', channel: 'stable', current: '0.3.13', latest: '0.3.13', note: 'English' }, en), '0.3.13 is the newest version.')
  assert.equal(updateStatusText({ status: 'empty', channel: 'beta', current: '0.3.13', latest: null, note: 'English' }, en), en.noBeta)
  assert.equal(updateStatusText({ status: 'error', channel: 'stable', current: '0.3.13', latest: null, note: 'HTTP 503' }, zh), 'HTTP 503')
  assert.notEqual(updateCopy('en').offerTitle, updateCopy('zh-CN').offerTitle)
  assert.match(updateCopy('zh-CN').notifyBody, /通知/)
})

test('the published appcast is a signed BlinkyBot zip and the notes follow the language', () => {
  const xml = readFileSync(new URL('../../../appcast.xml', import.meta.url), 'utf8')
  const key = readFileSync(new URL('../../../Scripts/sparkle-public-key.txt', import.meta.url), 'utf8').trim()
  const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
    build: { mac: { extendInfo: { SUPublicEDKey: string } } }
  }
  assert.equal(SPARKLE_PUBLIC_KEY, key)
  assert.equal(pkg.build.mac.extendInfo.SUPublicEDKey, key)
  assert.equal(isEd25519PublicKey(key), true)
  const english = readSparkleItem(xml, 'en')
  const chinese = readSparkleItem(xml, 'zh-CN')
  assert.ok(english && chinese)
  assert.equal(isBlinkyReleaseArchive(english.url), true)
  assert.equal(isEd25519Signature(english.edSignature), true)
  assert.equal(english.edSignature, chinese.edSignature)
  assert.ok((english.length ?? 0) > 1_000_000)
  // Link labels come from the feed writer for every version, so a new changelog does not break this.
  assert.match(english.notes, /Release notes on GitHub/)
  assert.doesNotMatch(english.notes, /在 GitHub 查看更新说明/)
  assert.match(chinese.notes, /在 GitHub 查看更新说明/)
  assert.doesNotMatch(chinese.notes, /Release notes on GitHub/)
  assert.equal(english.notes.includes('<'), false)
  assert.notEqual(english.notes, chinese.notes)
  assert.equal(canInstallArchive({ status: 'update', url: english.url, edSignature: english.edSignature, length: english.length }), true)
})

test('only a signed archive from this repository can be installed', () => {
  const good = candidate()
  assert.equal(canInstallArchive(good), true)
  assert.equal(canInstallArchive({ ...good, url: 'https://example.com/BlinkyBot-0.9.0.zip' }), false)
  assert.equal(canInstallArchive({ ...good, url: 'http://github.com/harrisliangsu/blinky-bot/releases/download/v0.9.0/BlinkyBot-0.9.0.zip' }), false)
  assert.equal(canInstallArchive({ ...good, url: 'https://github.com/other/blinky-bot/releases/download/v0.9.0/BlinkyBot-0.9.0.zip' }), false)
  assert.equal(canInstallArchive({ ...good, url: ZIP.replace(/\.zip$/, '.dmg') }), false)
  assert.equal(canInstallArchive({ ...good, edSignature: 'abc' }), false)
  assert.equal(canInstallArchive({ ...good, length: 900 * 1024 * 1024 }), false)
  assert.equal(canInstallArchive({ ...good, status: 'current' }), false)
  assert.equal(isBlinkyReleasePage(PAGE), true)
  assert.equal(isBlinkyReleasePage('https://github.com/harrisliangsu/blinky-bot'), false)
  assert.equal(isAllowedDownloadUrl('https://objects.githubusercontent.com/github-production-release-asset/1/2'), true)
  assert.equal(isAllowedDownloadUrl('https://evil.example/BlinkyBot.zip'), false)
})

test('a changed byte or the wrong key is not installed', () => {
  const publicKey = Buffer.from(pair.publicKey).toString('base64')
  assert.deepEqual(acceptDownloadedArchive(signedBytes, goodSignature, publicKey, signedBytes.byteLength), { ok: true })
  const tampered = new Uint8Array(signedBytes)
  tampered[0] = 9
  assert.deepEqual(acceptDownloadedArchive(tampered, goodSignature, publicKey, tampered.byteLength), { ok: false, reason: 'signature' })
  assert.deepEqual(acceptDownloadedArchive(signedBytes, goodSignature, SPARKLE_PUBLIC_KEY, signedBytes.byteLength), { ok: false, reason: 'signature' })
  assert.deepEqual(acceptDownloadedArchive(signedBytes, goodSignature, publicKey, 99), { ok: false, reason: 'length' })
  assert.equal(verifySparkleSignature(signedBytes, 'not-base64', publicKey), false)
})

test('the download follows a GitHub asset host and refuses any other redirect', async () => {
  const root = mkdtempSync(join(tmpdir(), 'blinky-update-test-'))
  try {
    const dest = join(root, 'BlinkyBot.zip')
    const bytes = Uint8Array.from([7, 8, 9])
    const size = await downloadReleaseArchive(ZIP, dest, 10, async (url) => {
      if (url === ZIP) return response(302, { location: 'https://objects.githubusercontent.com/asset/BlinkyBot.zip' }, null)
      assert.equal(url, 'https://objects.githubusercontent.com/asset/BlinkyBot.zip')
      return response(200, { 'content-length': '3' }, bytes)
    })
    assert.equal(size, 3)
    assert.deepEqual(readFileSync(dest), Buffer.from(bytes))

    await assert.rejects(
      downloadReleaseArchive(ZIP, join(root, 'bad.zip'), 10, async () => response(302, { location: 'https://evil.example/BlinkyBot.zip' }, null)),
      /unexpected host/
    )
    await assert.rejects(downloadReleaseArchive('https://evil.example/BlinkyBot.zip', dest, 10, async () => response(200, {}, bytes)), /not a BlinkyBot release/)
    await assert.rejects(
      downloadReleaseArchive(ZIP, join(root, 'big.zip'), 10, async () => response(200, { 'content-length': '11' }, bytes)),
      /larger than expected/
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the installer only replaces the installed BlinkyBot.app', () => {
  assert.equal(runningAppBundle('/Applications/BlinkyBot.app/Contents/MacOS/BlinkyBot'), '/Applications/BlinkyBot.app')
  assert.equal(canInstallOver(runningAppBundle('/Applications/BlinkyBot Preview.app/Contents/MacOS/BlinkyBot Preview')), false)
  assert.equal(runningAppBundle('/usr/bin/blinky'), null)
  const root = mkdtempSync(join(tmpdir(), 'blinky-extract-'))
  try {
    mkdirSync(join(root, 'Other.app'))
    mkdirSync(join(root, 'wrapper', 'BlinkyBot.app'), { recursive: true })
    assert.equal(findExtractedApp(root), join(root, 'wrapper', 'BlinkyBot.app'))
    mkdirSync(join(root, 'BlinkyBot.app'))
    assert.equal(findExtractedApp(root), join(root, 'BlinkyBot.app'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  const source = '/tmp/extract/BlinkyBot.app'
  const target = '/Applications/BlinkyBot.app'
  assert.deepEqual(installArguments(42, source, target, '/tmp/blinky-update'), ['42', source, target, '/tmp/blinky-update'])
  assert.equal(installArguments(42, '/tmp/extract/BlinkyBot Preview.app', target, '/tmp/blinky-update'), null)
  assert.equal(installArguments(1, source, target, '/tmp/blinky-update'), null)
  assert.match(INSTALL_HELPER, /ditto/)
  assert.match(INSTALL_HELPER, /com\.apple\.quarantine/)
  assert.match(INSTALL_HELPER, /\.previous/)
})

test('a reminder file round-trips and a broken file asks again', async () => {
  const root = mkdtempSync(join(tmpdir(), 'blinky-reminder-'))
  const path = join(root, 'update-prompt.json')
  try {
    await writeReminder(path, { skippedVersion: '0.9.0', laterUntil: 12 })
    assert.deepEqual(await readReminder(path), { skippedVersion: '0.9.0', laterUntil: 12 })
    writeFileSync(path, '{')
    assert.deepEqual(await readReminder(path), { skippedVersion: null, laterUntil: null })
    assert.deepEqual(await readReminder(join(root, 'missing.json')), { skippedVersion: null, laterUntil: null })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function response(status: number, headers: Record<string, string>, body: Uint8Array | null): ArchiveResponse {
  return {
    status,
    header: (name) => headers[name.toLowerCase()] ?? null,
    body: body ? Readable.from([Buffer.from(body)]) : null,
    cancel() {}
  }
}
