import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { SafeStorage } from 'electron'
import { connectGoogle, googleAccessToken, invalidateGoogleAccessToken, sendGmailRaw, setGoogleOAuthTransportForTests } from './googleOAuth.ts'
import { readGoogleCredentials, saveGoogleCredentials, setGoogleStorageForTests } from './googleSecrets.ts'
import { invalidateXAccess, postXMessage, setXTransportForTests } from './xOAuth.ts'
import { readXCredentials, saveXCredentials, setXStorageForTests } from './xSecrets.ts'

// No provider requests, browser, Electron, real account or real encryption.
const storage = { isEncryptionAvailable: () => true, encryptString: (v: string) => Buffer.from(v), decryptString: (v: Buffer) => v.toString() } as unknown as SafeStorage
const googleScopes = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send']

test('refresh grants cannot silently lose send access and rotated Google grants survive later refreshes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-refresh-grants-')), previousRoot = process.env.OPENBOT_DATA_DIR
  process.env.OPENBOT_DATA_DIR = root
  setGoogleStorageForTests(storage); setXStorageForTests(storage)
  try {
    await saveGoogleCredentials('gmail', { clientId: '123456789-test.apps.googleusercontent.com', refreshToken: 'fixture-original', scopes: googleScopes, account: 'fixture@example.test' })
    await saveXCredentials({ clientId: 'fixture-x-client', refreshToken: 'fixture-original', userId: '123', username: 'fixture' })
    await t.test('Google denies a reduced refresh grant before submitting mail', async () => {
      invalidateGoogleAccessToken('gmail')
      let sends = 0
      setGoogleOAuthTransportForTests((async (input) => {
        if (String(input).endsWith('/token')) return Response.json({ access_token: 'fixture-access', scope: googleScopes.filter((scope) => !scope.endsWith('gmail.send')).join(' '), expires_in: 3600 })
        sends++; return Response.json({ id: 'must-not-send' })
      }) as typeof fetch)
      await assert.rejects(sendGmailRaw('fixture-message', 'fixture@example.test'), /required permissions/)
      assert.equal(sends, 0)
    })
    await t.test('Google persists rotation before returning access and uses it on the next refresh', async () => {
      invalidateGoogleAccessToken('gmail')
      const used: string[] = []
      setGoogleOAuthTransportForTests((async (_input, init) => {
        used.push((init?.body as URLSearchParams).get('refresh_token')!)
        return Response.json({ access_token: 'fixture-access', refresh_token: `fixture-rotated-${used.length}`, scope: googleScopes.join(' '), expires_in: 3600 })
      }) as typeof fetch)
      assert.equal(await googleAccessToken('gmail'), 'fixture-access')
      assert.equal((await readGoogleCredentials('gmail'))?.refreshToken, 'fixture-rotated-1')
      invalidateGoogleAccessToken('gmail')
      await googleAccessToken('gmail')
      assert.deepEqual(used, ['fixture-original', 'fixture-rotated-1'])
      assert.equal((await readGoogleCredentials('gmail'))?.refreshToken, 'fixture-rotated-2')
    })
    await t.test('Google accepts an omitted unchanged scope but rejects a malformed explicit scope', async () => {
      for (const [scope, allowed] of [[undefined, true], [[], false]] as const) {
        invalidateGoogleAccessToken('gmail')
        setGoogleOAuthTransportForTests((async () => Response.json({ access_token: 'fixture-access', ...(scope !== undefined ? { scope } : {}) })) as typeof fetch)
        if (allowed) assert.equal(await googleAccessToken('gmail'), 'fixture-access')
        else await assert.rejects(googleAccessToken('gmail'), /required permissions/)
      }
    })
    await t.test('X denies a reduced refresh grant before posting and preserves the saved record', async () => {
      invalidateXAccess()
      let posts = 0
      setXTransportForTests((async (input) => {
        if (String(input).endsWith('/token')) return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-rotated', scope: 'tweet.read users.read offline.access' })
        posts++; return Response.json({ data: { id: '456' } })
      }) as typeof fetch)
      await assert.rejects(postXMessage('123', 'fixture message'), /required permissions/)
      assert.equal(posts, 0)
      assert.equal((await readXCredentials())?.refreshToken, 'fixture-original')
    })
    await t.test('X accepts a full explicit grant and posts only after token rotation is saved', async () => {
      invalidateXAccess()
      let posts = 0
      setXTransportForTests((async (input) => {
        if (String(input).endsWith('/token')) return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-rotated', scope: 'tweet.read tweet.write users.read offline.access' })
        assert.equal((await readXCredentials())?.refreshToken, 'fixture-rotated')
        posts++; return Response.json({ data: { id: '456' } })
      }) as typeof fetch)
      assert.equal(await postXMessage('123', 'fixture message'), '456')
      assert.equal(posts, 1)
    })
    await t.test('a late rotating Google refresh cannot replace the account being reconnected', async () => {
      invalidateGoogleAccessToken('gmail')
      let beginRefresh!: () => void, releaseOldRefresh!: (response: Response) => void
      const entered = new Promise<void>((resolve) => { beginRefresh = resolve })
      const oldResponse = new Promise<Response>((resolve) => { releaseOldRefresh = resolve })
      setGoogleOAuthTransportForTests((async (input, init) => {
        if (String(input).endsWith('/token')) {
          if ((init?.body as URLSearchParams).get('grant_type') === 'refresh_token') { beginRefresh(); return oldResponse }
          return Response.json({ access_token: 'fixture-new-account', refresh_token: 'fixture-reconnected', scope: googleScopes.join(' ') })
        }
        if (String(input).includes('/userinfo')) return Response.json({ email: 'new-account@example.test', email_verified: true })
        return Response.json({ emailAddress: 'new-account@example.test' })
      }) as typeof fetch, async (value) => {
        const url = new URL(value), callback = new URL(url.searchParams.get('redirect_uri')!)
        callback.searchParams.set('state', url.searchParams.get('state')!); callback.searchParams.set('code', 'fixture-reconnect')
        await fetch(callback)
      })
      const oldRefresh = googleAccessToken('gmail'); void oldRefresh.catch(() => {})
      await entered
      setGoogleStorageForTests({ ...storage, encryptString: (value: string) => {
        if (JSON.parse(value).account === 'new-account@example.test') releaseOldRefresh(Response.json({ access_token: 'fixture-old-account', refresh_token: 'fixture-old-rotated', scope: googleScopes.join(' ') }))
        return Buffer.from(value)
      } } as unknown as SafeStorage)
      await connectGoogle('gmail')
      await assert.rejects(oldRefresh, /authorization changed/)
      const saved = await readGoogleCredentials('gmail')
      assert.equal(saved?.account, 'new-account@example.test')
      assert.equal(saved?.refreshToken, 'fixture-reconnected')
      setGoogleStorageForTests(storage)
    })
  } finally {
    invalidateGoogleAccessToken('gmail'); invalidateXAccess()
    setGoogleOAuthTransportForTests(); setXTransportForTests(); setGoogleStorageForTests(undefined); setXStorageForTests(undefined)
    if (previousRoot === undefined) delete process.env.OPENBOT_DATA_DIR; else process.env.OPENBOT_DATA_DIR = previousRoot
    await rm(root, { recursive: true, force: true })
  }
})
