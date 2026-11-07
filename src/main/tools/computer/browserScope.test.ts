import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { browserScopeId, browserScopeMode, peekBrowserScopeMode } from './browserScope.ts'
import { profileLayout } from './browser/profile.ts'

test('new browsers isolate each Bot conversation and preserve their scope after reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-browser-scope-'))
  try {
    assert.equal(peekBrowserScopeMode('bot', root), 'session')
    const a = browserScopeId('bot', 'chat-a', root)
    const b = browserScopeId('bot', 'chat-b', root)
    const otherBot = browserScopeId('other-bot', 'chat-a', root)
    assert.equal(a.mode, 'session')
    assert.notEqual(a.id, b.id)
    assert.notEqual(a.id, otherBot.id)
    assert.deepEqual(browserScopeId('bot', 'chat-a', root), a)
    assert.throws(() => browserScopeId('bot', undefined, root), /conversation id/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a missing session does not persist a policy before legacy ownership is known', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-browser-no-session-'))
  try {
    assert.throws(() => browserScopeId('bot', undefined, root), /conversation id/)
    await mkdir(profileLayout('bot', root).root, { recursive: true })
    assert.deepEqual(browserScopeId('bot', 'chat', root), { id: 'bot', mode: 'legacy' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a blank Bot owner cannot create a policy even with a session id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-browser-no-owner-'))
  try {
    assert.throws(() => browserScopeId(' ', 'chat', root), /Bot owner/)
    assert.throws(() => browserScopeId('..', 'chat', root), /Invalid browser owner/)
    assert.throws(() => browserScopeId('.', 'chat', root), /Invalid browser owner/)
    await assert.rejects(readdir(join(root, 'computers')), { code: 'ENOENT' })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('legacy profile stays bot-scoped and is not moved, deleted or assigned a guessed owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-browser-legacy-'))
  try {
    const legacy = profileLayout('bot', root).root
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'fixture'), 'old data')
    assert.equal(peekBrowserScopeMode('bot', root), 'legacy')
    assert.deepEqual(browserScopeId('bot', 'first', root), { id: 'bot', mode: 'legacy' })
    assert.deepEqual(browserScopeId('bot', 'second', root), { id: 'bot', mode: 'legacy' })
    assert.equal(await readFile(join(legacy, 'fixture'), 'utf8'), 'old data')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a damaged ownership record refuses access without rewriting it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-browser-corrupt-'))
  try {
    browserScopeMode('bot', root)
    const dir = join(root, 'computers')
    const name = (await readdir(dir)).find((entry) => entry.startsWith('.scope-v1-'))!
    await writeFile(join(dir, name), '{broken')
    assert.throws(() => browserScopeId('bot', 'chat', root))
    assert.equal(await readFile(join(dir, name), 'utf8'), '{broken')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('parallel processes publish one stable scope policy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-browser-race-'))
  try {
    const moduleUrl = new URL('./browserScope.ts', import.meta.url).href
    const script = `import { browserScopeId } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(browserScopeId('bot','chat',process.argv[1])))`
    const child = () => new Promise<string>((resolve, reject) => {
      const proc = spawn(process.execPath, ['--experimental-transform-types', '--import', './scripts/register-ts.mjs', '--input-type=module', '-e', script, root], { cwd: process.cwd() })
      let stdout = '', stderr = ''
      proc.stdout.on('data', (chunk) => { stdout += chunk })
      proc.stderr.on('data', (chunk) => { stderr += chunk })
      proc.on('error', reject)
      proc.on('exit', (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr)))
    })
    const results = await Promise.all(Array.from({ length: 8 }, child))
    assert.equal(new Set(results).size, 1)
    assert.equal(JSON.parse(results[0]).mode, 'session')
    assert.equal((await readdir(join(root, 'computers'))).filter((entry) => entry.endsWith('.json')).length, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})
