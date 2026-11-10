import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { SafeStorage } from 'electron'
import { githubIssueFingerprint } from './githubWatch.ts'
import { disconnectGitHub, postGitHubIssueComment, setGitHubTransportForTests } from './githubOAuth.ts'
import { saveGitHubCredentials, setGitHubStorageForTests } from './githubSecrets.ts'

test('GitHub reads and confirmed comments use the stored token, never gh', async () => {
  const root = await mkdtemp(join(tmpdir(), 'github-fixture-'))
  const oldData = process.env.OPENBOT_DATA_DIR, oldPath = process.env.PATH
  process.env.OPENBOT_DATA_DIR = root
  const bin = join(root, 'bin'), trace = join(root, 'gh-calls')
  await mkdir(bin)
  await writeFile(join(bin, 'gh'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(trace)}, 'called\\n'); process.exit(0);\n`, { mode: 0o700 })
  process.env.PATH = `${bin}${oldPath ? `:${oldPath}` : ''}`
  setGitHubStorageForTests({ isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value), decryptString: (value: Buffer) => value.toString() } as unknown as SafeStorage)
  let calls = 0
  setGitHubTransportForTests((async (input: string | URL | Request, init?: RequestInit) => {
    calls++
    const url = String(input)
    if (url.endsWith('/access_token')) return Response.json({ access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token', expires_in: 28800, token_type: 'bearer', scope: '' })
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-access-token')
    if (url.endsWith('/issues/7/comments')) return Response.json({ id: 4, html_url: 'https://github.com/fixture/repo/pull/7#issuecomment-4' })
    if (url.endsWith('/issues/7')) return Response.json({ number: 7, url, updated_at: '2026-11-06T00:00:00Z', state: 'open', title: 'Fixture', body: 'Synthetic fixture', comments: 0, labels: [], assignees: [], milestone: null })
    throw new Error('unexpected endpoint')
  }) as typeof fetch)
  try {
    await saveGitHubCredentials({ clientId: 'Iv1.fixtureClient123', clientSecret: 'fixture-github-secret', refreshToken: 'fixture-refresh-token', login: 'fixture-user' })
    const first = await githubIssueFingerprint('fixture', 'repo', 7)
    assert.match(first, /^[a-f0-9]{64}$/)
    assert.equal(await githubIssueFingerprint('fixture', 'repo', 7), first)
    assert.equal(await postGitHubIssueComment('fixture', 'repo', 7, 'kept local until confirmed'), 'https://github.com/fixture/repo/pull/7#issuecomment-4')
    await disconnectGitHub()
    await assert.rejects(githubIssueFingerprint('fixture', 'repo', 7), /not connected/)
    await assert.rejects(readFile(trace, 'utf8'), /ENOENT/)
    assert.ok(calls >= 2)
  } finally {
    setGitHubTransportForTests(); setGitHubStorageForTests(undefined)
    if (oldData === undefined) delete process.env.OPENBOT_DATA_DIR; else process.env.OPENBOT_DATA_DIR = oldData
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath
    await rm(root, { recursive: true, force: true })
  }
})
