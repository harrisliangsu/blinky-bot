import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { SafeStorage } from 'electron'
import { connectGoogle, disconnectGoogle, googleAccessToken, hasGoogleClient, invalidateGoogleAccessToken, setGoogleOAuthTransportForTests } from './googleOAuth.ts'
import { readGoogleCredentials, saveGoogleCredentials, setGoogleStorageForTests } from './googleSecrets.ts'
import { connectX, disconnectX, hasXClient, invalidateXAccess, setXTransportForTests, xAccessToken } from './xOAuth.ts'
import { readXCredentials, saveXCredentials, setXStorageForTests } from './xSecrets.ts'
import { githubEnabled, requireGitHubConnection, setGitHubEnabled } from './githubConnection.ts'

const storage = { isEncryptionAvailable: () => true, encryptString: (text: string) => Buffer.from([...text].reverse().join('')), decryptString: (bytes: Buffer) => [...bytes.toString()].reverse().join('') } as unknown as SafeStorage
const clientId = '123456789-test.apps.googleusercontent.com'
const scopes = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send']
const googleGrant = { clientId, clientSecret: 'fixture-secret', refreshToken: 'fixture-refresh', scopes, account: 'fixture@example.test' }
const xGrant = { clientId: 'fixture-x-client', refreshToken: 'fixture-refresh', userId: '123', username: 'fixture' }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r }); return { promise, resolve } }

// Transport callbacks simulate protocol responses only. No provider login or user data is used.
test('connection provisioning, compatibility, cancellation and disconnect persistence', { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-connect-lifecycle-'))
  const oldRoot = process.env.OPENBOT_DATA_DIR
  const envKeys = ['BLINKY_GOOGLE_CLIENT_ID', 'BLINKY_GOOGLE_CLIENT_SECRET', 'BLINKY_X_CLIENT_ID'] as const
  const oldEnv = envKeys.map((key) => process.env[key])
  process.env.OPENBOT_DATA_DIR = root
  for (const key of envKeys) delete process.env[key]
  setGoogleStorageForTests(storage); setXStorageForTests(storage)
  try {
    await t.test('no configured client fails before opening a browser; metadata does not pretend connected', async () => {
      let opened = 0
      setGoogleOAuthTransportForTests(undefined, async () => { opened++ })
      setXTransportForTests(undefined, async () => { opened++ })
      assert.equal(await hasGoogleClient('gmail'), false); assert.equal(await hasXClient(), false)
      await assert.rejects(connectGoogle('gmail'), /distribution needs/)
      await assert.rejects(connectX(), /distribution needs/)
      assert.equal(opened, 0)
    })
    await t.test('distributor client starts actual PKCE callback flow without renderer client fields', async () => {
      process.env.BLINKY_GOOGLE_CLIENT_ID = clientId
      process.env.BLINKY_GOOGLE_CLIENT_SECRET = 'fixture-distributor-secret'
      process.env.BLINKY_X_CLIENT_ID = xGrant.clientId
      let googleScopes = '', xScopes = ''
      setGoogleOAuthTransportForTests((async (url, init) => {
        if (String(url).endsWith('/token')) {
          const body = init?.body as URLSearchParams
          assert.equal(body.get('client_id'), clientId); assert.equal(body.get('client_secret'), 'fixture-distributor-secret')
          assert.ok(body.get('code_verifier'))
          return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', scope: googleScopes })
        }
        if (String(url).includes('/userinfo')) return Response.json({ email: googleGrant.account, email_verified: true })
        return Response.json({ emailAddress: googleGrant.account })
      }) as typeof fetch, async (url) => {
        const auth = new URL(url); googleScopes = auth.searchParams.get('scope')!
        assert.equal(auth.hostname, 'accounts.google.com'); assert.equal(auth.searchParams.get('client_id'), clientId)
        assert.equal(auth.searchParams.get('code_challenge_method'), 'S256')
        await fetch(`${auth.searchParams.get('redirect_uri')}?state=${auth.searchParams.get('state')}&code=fixture-code`)
      })
      setXTransportForTests((async (url, init) => {
        if (String(url).endsWith('/token')) { assert.equal((init?.body as URLSearchParams).get('client_id'), xGrant.clientId); return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', scope: xScopes }) }
        return Response.json({ data: { id: '123', username: 'fixture' } })
      }) as typeof fetch, async (url) => {
        const auth = new URL(url); xScopes = auth.searchParams.get('scope')!
        assert.equal(auth.hostname, 'x.com'); assert.equal(auth.searchParams.get('code_challenge_method'), 'S256')
        await fetch(`${auth.searchParams.get('redirect_uri')}?state=${auth.searchParams.get('state')}&code=fixture-code`)
      })
      assert.equal(await hasGoogleClient('gmail'), true); assert.equal(await hasXClient(), true)
      await connectGoogle('gmail'); await connectX()
      assert.equal((await readGoogleCredentials('gmail'))?.clientSecret, 'fixture-distributor-secret')
      assert.equal((await readXCredentials())?.clientId, xGrant.clientId)
      for (const file of ['google-connections.json', 'x-connection.json']) assert.ok(!(await readFile(join(root, file), 'utf8')).includes('fixture-refresh'))
      for (const key of envKeys) delete process.env[key]
    })
    await t.test('saved native clients are read from disk and reused; service grants remain separate', async () => {
      setGoogleStorageForTests(undefined); setXStorageForTests(undefined)
      setGoogleStorageForTests(storage); setXStorageForTests(storage)
      assert.equal(await hasGoogleClient('gmail'), true)
      assert.equal(await hasGoogleClient('calendar'), true)
      assert.equal(await readGoogleCredentials('calendar'), null)
      assert.equal(await hasXClient(), true)
      await connectGoogle('gmail'); await connectX()
      assert.equal((await readGoogleCredentials('gmail'))?.account, googleGrant.account)
    })
    await t.test('disconnect during Google token exchange cancels late credential writes', async () => {
      const entered = deferred<void>(), response = deferred<Response>()
      setGoogleOAuthTransportForTests((async (url) => {
        if (String(url).endsWith('/token')) { entered.resolve(); return response.promise }
        if (String(url).includes('/userinfo')) return Response.json({ email: googleGrant.account, email_verified: true })
        return Response.json({})
      }) as typeof fetch, async (url) => {
        const auth = new URL(url)
        await fetch(`${auth.searchParams.get('redirect_uri')}?state=${auth.searchParams.get('state')}&code=fixture-code`)
      })
      const connecting = connectGoogle('gmail'); void connecting.catch(() => undefined)
      await entered.promise
      const removing = disconnectGoogle('gmail')
      await assert.rejects(connectGoogle('gmail'), /already in progress/)
      response.resolve(Response.json({ access_token: 'fixture-access', refresh_token: 'late-refresh', scope: scopes.join(' ') }))
      await assert.rejects(connecting, /cancelled/); await removing
      assert.equal(await readGoogleCredentials('gmail'), null)
      assert.equal(await hasGoogleClient('gmail'), false)
    })
    await t.test('disconnect cancels a Google refresh and prevents token use', async () => {
      await saveGoogleCredentials('gmail', googleGrant); invalidateGoogleAccessToken('gmail')
      const entered = deferred<void>(), response = deferred<Response>()
      setGoogleOAuthTransportForTests((async () => { entered.resolve(); return response.promise }) as typeof fetch)
      const refreshing = googleAccessToken('gmail'); void refreshing.catch(() => undefined)
      await entered.promise; const removing = disconnectGoogle('gmail')
      await assert.rejects(googleAccessToken('gmail'), /disconnecting/)
      response.resolve(Response.json({ access_token: 'late-access' }))
      await assert.rejects(refreshing, /changed/); await removing
      assert.equal(await readGoogleCredentials('gmail'), null)
    })
    await t.test('disconnect during X rotation cannot restore a saved credential', async () => {
      await saveXCredentials(xGrant); invalidateXAccess()
      const entered = deferred<void>(), response = deferred<Response>()
      setXTransportForTests((async () => { entered.resolve(); return response.promise }) as typeof fetch)
      const refreshing = xAccessToken(); void refreshing.catch(() => undefined)
      await entered.promise; const removing = disconnectX()
      await assert.rejects(xAccessToken(), /disconnecting/)
      await assert.rejects(connectX(), /already in progress/)
      response.resolve(Response.json({ access_token: 'late-access', refresh_token: 'late-refresh' }))
      await assert.rejects(refreshing, /refreshed/); await removing
      assert.equal(await readXCredentials(), null)
    })
    await t.test('disconnect without a provider grant is idempotent', async () => {
      await Promise.all([disconnectGoogle('gmail'), disconnectGoogle('gmail')]); await Promise.all([disconnectX(), disconnectX()])
      assert.equal(await readGoogleCredentials('gmail'), null); assert.equal(await readXCredentials(), null)
    })
    await t.test('GitHub opt-out is local, persistent, denies connector use, and preserves damaged files', async () => {
      assert.equal(await githubEnabled(), true)
      await setGitHubEnabled(false)
      await assert.rejects(requireGitHubConnection(), /disconnected/)
      assert.deepEqual(JSON.parse(await readFile(join(root, 'github-connection.json'), 'utf8')), { version: 1, enabled: false })
      await setGitHubEnabled(true); await requireGitHubConnection()
      await writeFile(join(root, 'github-connection.json'), '{damaged')
      await assert.rejects(setGitHubEnabled(false), /damaged/)
      assert.equal(await readFile(join(root, 'github-connection.json'), 'utf8'), '{damaged')
    })
  } finally {
    invalidateGoogleAccessToken('gmail'); invalidateGoogleAccessToken('calendar'); invalidateXAccess()
    setGoogleOAuthTransportForTests(); setXTransportForTests(); setGoogleStorageForTests(undefined); setXStorageForTests(undefined)
    if (oldRoot === undefined) delete process.env.OPENBOT_DATA_DIR; else process.env.OPENBOT_DATA_DIR = oldRoot
    envKeys.forEach((key, index) => { if (oldEnv[index] === undefined) delete process.env[key]; else process.env[key] = oldEnv[index] })
    await rm(root, { recursive: true, force: true })
  }
})
