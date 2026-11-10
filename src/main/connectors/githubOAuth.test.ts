import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { SafeStorage } from 'electron'
import { connectGitHub, disconnectGitHub, githubAccessToken, GITHUB_AUTHORIZE_SCOPE, GITHUB_REDIRECT, invalidateGitHubAccess, postGitHubIssueComment, readGitHubIssue, setGitHubTransportForTests, verifyGitHubConnection } from './githubOAuth.ts'
import { clearGitHubCredentials, readGitHubCredentials, setGitHubStorageForTests } from './githubSecrets.ts'

test('GitHub OAuth uses PKCE loopback, refuses gh, and posts only a confirmed issue comment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-github-oauth-'))
  const oldData = process.env.OPENBOT_DATA_DIR, oldId = process.env.BLINKY_GITHUB_CLIENT_ID, oldSecret = process.env.BLINKY_GITHUB_CLIENT_SECRET
  process.env.OPENBOT_DATA_DIR = root
  delete process.env.BLINKY_GITHUB_CLIENT_ID
  delete process.env.BLINKY_GITHUB_CLIENT_SECRET
  setGitHubStorageForTests({ isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from([...value].reverse().join('')), decryptString: (value: Buffer) => [...value.toString()].reverse().join('') } as unknown as SafeStorage)
  let scope = '', challenge = '', pkce = false, posts = 0, refreshes = 0, exchanges = 0, callbackError = false, secretInBrowser = false, badScope = false
  const clientId = 'Iv1.fixtureClient123', clientSecret = 'fixture-github-secret'
  setGitHubTransportForTests((async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url === 'https://github.com/login/oauth/access_token') {
      const body = init?.body as URLSearchParams
      assert.equal(body.get('client_id'), clientId)
      assert.equal(body.get('client_secret'), clientSecret)
      if (body.get('grant_type') === 'refresh_token') { refreshes++; assert.equal(body.get('refresh_token'), 'fixture-refresh-token'); return Response.json({ access_token: 'fixture-access-token', refresh_token: 'rotated-refresh-token', expires_in: 28800, token_type: 'bearer', scope: '' }) }
      exchanges++
      const { createHash } = await import('node:crypto')
      pkce = createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url') === challenge
      assert.equal(body.get('redirect_uri'), GITHUB_REDIRECT)
      return Response.json({ access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token', expires_in: 28800, token_type: 'bearer', scope: badScope ? 'repo' : scope })
    }
    const header = new Headers(init?.headers).get('authorization')
    assert.equal(header, 'Bearer fixture-access-token')
    assert.equal(new Headers(init?.headers).get('x-github-api-version'), '2022-11-28')
    if (url === 'https://api.github.com/user') return Response.json({ login: 'fixture-user' })
    if (url === 'https://api.github.com/repos/fixture/repo/issues/7') return Response.json({ number: 7, url, updated_at: '2026-11-06T00:00:00Z', state: 'open', title: 'Fixture', body: 'Synthetic', comments: 0, labels: [], assignees: [], milestone: null })
    if (url === 'https://api.github.com/repos/fixture/repo/issues/7/comments' && init?.method === 'POST') {
      posts++
      assert.deepEqual(JSON.parse(String(init.body)), { body: 'fixture comment' })
      return Response.json({ id: 99, html_url: 'https://github.com/fixture/repo/issues/7#issuecomment-99' }, { status: 201 })
    }
    throw new Error('unexpected endpoint ' + url)
  }) as typeof fetch, async (input) => {
    const auth = new URL(input)
    scope = auth.searchParams.get('scope')!
    challenge = auth.searchParams.get('code_challenge')!
    secretInBrowser = auth.searchParams.has('client_secret') || input.includes(clientSecret)
    assert.equal(auth.origin + auth.pathname, 'https://github.com/login/oauth/authorize')
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(auth.searchParams.get('redirect_uri'), GITHUB_REDIRECT)
    assert.equal(auth.searchParams.get('client_id'), clientId)
    const state = auth.searchParams.get('state')!
    assert.equal((await fetch(`${GITHUB_REDIRECT}?state=wrong&code=invalid`)).status, 400)
    assert.equal((await fetch(`${GITHUB_REDIRECT}?state=${encodeURIComponent(state)}&code=fixture-code${callbackError ? '&error=access_denied' : ''}`)).status, 200)
  })
  try {
    await assert.rejects(connectGitHub(), /distribution needs/)
    process.env.BLINKY_GITHUB_CLIENT_ID = clientId
    process.env.BLINKY_GITHUB_CLIENT_SECRET = clientSecret
    assert.deepEqual(await connectGitHub(), { login: 'fixture-user' })
    assert.equal(scope, GITHUB_AUTHORIZE_SCOPE)
    assert.ok(pkce)
    assert.equal(secretInBrowser, false)
    const stored = await readFile(join(root, 'github-oauth.json'), 'utf8')
    assert.ok(!stored.includes('fixture-refresh-token'))
    assert.ok(!stored.includes('fixture-access-token'))
    assert.ok(!stored.includes(clientSecret))
    invalidateGitHubAccess()
    assert.equal(await githubAccessToken(), 'fixture-access-token')
    assert.equal((await readGitHubCredentials())?.refreshToken, 'rotated-refresh-token')
    assert.deepEqual(await verifyGitHubConnection(), { login: 'fixture-user' })
    assert.equal(refreshes, 1)
    assert.equal((await readGitHubIssue('fixture', 'repo', 7)).title, 'Fixture')
    assert.equal(await postGitHubIssueComment('fixture', 'repo', 7, 'fixture comment'), 'https://github.com/fixture/repo/issues/7#issuecomment-99')
    assert.equal(posts, 1)
    await assert.rejects(postGitHubIssueComment('fixture', 'repo', 7, ''), /required/)
    callbackError = true
    const saved = await readGitHubCredentials(), before = exchanges, beforePosts = posts
    await assert.rejects(connectGitHub(), /declined/)
    assert.equal(exchanges, before)
    assert.equal(posts, beforePosts)
    assert.deepEqual(await readGitHubCredentials(), saved)
    callbackError = false
    badScope = true
    await assert.rejects(connectGitHub(), /renewable|permissions/)
    assert.equal(exchanges, before + 1)
    assert.equal(posts, beforePosts)
    assert.deepEqual(await readGitHubCredentials(), saved)
    await disconnectGitHub()
    assert.equal(await readGitHubCredentials(), null)
    await assert.rejects(readGitHubIssue('fixture', 'repo', 7), /not connected/)
    assert.equal(posts, beforePosts)
    invalidateGitHubAccess(); await clearGitHubCredentials()
  } finally {
    invalidateGitHubAccess(); setGitHubTransportForTests(); setGitHubStorageForTests(undefined)
    if (oldData === undefined) delete process.env.OPENBOT_DATA_DIR; else process.env.OPENBOT_DATA_DIR = oldData
    if (oldId === undefined) delete process.env.BLINKY_GITHUB_CLIENT_ID; else process.env.BLINKY_GITHUB_CLIENT_ID = oldId
    if (oldSecret === undefined) delete process.env.BLINKY_GITHUB_CLIENT_SECRET; else process.env.BLINKY_GITHUB_CLIENT_SECRET = oldSecret
    await rm(root, { recursive: true, force: true })
  }
})
