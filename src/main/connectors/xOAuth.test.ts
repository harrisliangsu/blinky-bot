import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { SafeStorage } from 'electron'
import { connectX, invalidateXAccess, postXMessage, readXPost, setXTransportForTests, verifyXConnection, xAccessToken, X_REDIRECT } from './xOAuth.ts'
import { clearXCredentials, readXCredentials, setXStorageForTests } from './xSecrets.ts'

test('X OAuth validates callback and account, rotates credentials, and posts only to the bound identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-x-oauth-')); process.env.OPENBOT_DATA_DIR = root
  setXStorageForTests({ isEncryptionAvailable: () => true, encryptString: (v: string) => Buffer.from(v.split('').reverse().join('')), decryptString: (v: Buffer) => v.toString().split('').reverse().join('') } as unknown as SafeStorage)
  let scopes = '', challenge = '', pkce = false, failIdentity = false, posts = 0, refreshes = 0, exchanges = 0, callbackError = false
  setXTransportForTests((async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url === 'https://api.x.com/2/oauth2/token') {
      const body = init?.body as URLSearchParams
      if (body.get('grant_type') === 'authorization_code') { exchanges++; const { createHash } = await import('node:crypto'); pkce = createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url') === challenge; return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', scope: scopes }) }
      assert.equal(body.get('refresh_token'), 'fixture-refresh'); refreshes++; return Response.json({ access_token: 'fixture-access', refresh_token: 'rotated-refresh', expires_in: 3600 })
    }
    if (url === 'https://api.x.com/2/users/me') return failIdentity ? new Response('', { status: 403 }) : Response.json({ data: { id: '123', username: 'fixture' } })
    if (url.startsWith('https://api.x.com/2/tweets/456?')) return Response.json({ data: { id: '456', text: 'untrusted fixture', author_id: '123' } })
    if (url === 'https://api.x.com/2/tweets') { posts++; assert.deepEqual(JSON.parse(String(init?.body)), { text: 'fixture message' }); return Response.json({ data: { id: '456' } }, { status: 201 }) }
    throw new Error('unexpected endpoint')
  }) as typeof fetch, async (input) => {
    const auth = new URL(input); scopes = auth.searchParams.get('scope')!; challenge = auth.searchParams.get('code_challenge')!
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256'); assert.equal(auth.searchParams.get('redirect_uri'), X_REDIRECT)
    const state = auth.searchParams.get('state')!
    assert.equal((await fetch(`${X_REDIRECT}?state=wrong&code=invalid`)).status, 400)
    assert.equal((await fetch(`${X_REDIRECT}?state=${encodeURIComponent(state)}&code=fixture-code${callbackError ? '&error=access_denied' : ''}`)).status, 200)
  })
  try {
    assert.deepEqual(await connectX('fixture-client-123'), { username: 'fixture' }); assert.ok(pkce)
    assert.ok(!(await readFile(join(root, 'x-connection.json'), 'utf8')).includes('fixture-refresh'))
    assert.equal(await xAccessToken(), 'fixture-access'); assert.equal((await readXCredentials())?.refreshToken, 'rotated-refresh')
    assert.deepEqual(await verifyXConnection(), { username: 'fixture' }); assert.equal(refreshes, 1)
    assert.equal((await readXPost('456')).text, 'untrusted fixture')
    await assert.rejects(readXPost('../other'), /Invalid/)
    await assert.rejects(postXMessage('999', 'fixture message'), /changed/); assert.equal(posts, 0)
    assert.equal(await postXMessage('123', 'fixture message'), '456'); assert.equal(posts, 1)
    failIdentity = true; await assert.rejects(connectX('fixture-client-123'), /failed/); assert.equal((await readXCredentials())?.refreshToken, 'rotated-refresh')
    // An error response must not be treated as a grant even if a code is present.
    // Keep the prior connection and never exchange the ambiguous callback.
    failIdentity = false; callbackError = true
    const saved = await readXCredentials(), before = exchanges, beforePosts = posts
    await assert.rejects(connectX('fixture-client-123'), /declined/)
    assert.equal(exchanges, before); assert.equal(posts, beforePosts)
    assert.deepEqual(await readXCredentials(), saved)
    invalidateXAccess(); await clearXCredentials(); assert.equal(await readXCredentials(), null)
  } finally { invalidateXAccess(); setXTransportForTests(); setXStorageForTests(undefined); await rm(root, { recursive: true, force: true }) }
})
