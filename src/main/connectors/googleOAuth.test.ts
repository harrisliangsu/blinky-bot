import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { SafeStorage } from 'electron'
import { connectGoogle, googleAccessToken, setGoogleOAuthTransportForTests, verifyGoogleConnection } from './googleOAuth.ts'
import { readGoogleCredentials, removeGoogleCredentials, setGoogleStorageForTests } from './googleSecrets.ts'

test('desktop OAuth validates state and scopes, verifies service, and preserves encrypted credentials on failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-google-oauth-'))
  process.env.OPENBOT_DATA_DIR = root
  const fakeStorage = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value.split('').reverse().join('')), decryptString: (bytes: Buffer) => bytes.toString().split('').reverse().join('') } as unknown as SafeStorage
  setGoogleStorageForTests(fakeStorage)
  let scopes = '', observedPkce = false, failedService = false
  const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url === 'https://oauth2.googleapis.com/token') {
      const body = init?.body as URLSearchParams
      if (body.get('grant_type') === 'authorization_code') { observedPkce = !!body.get('code_verifier'); return Response.json({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', scope: scopes }) }
      return Response.json({ access_token: 'fixture-access' })
    }
    if (url === 'https://openidconnect.googleapis.com/v1/userinfo') return Response.json({ email: 'fixture@example.test', email_verified: true })
    if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/profile') return failedService ? new Response('', { status: 403 }) : Response.json({ emailAddress: 'fixture@example.test' })
    throw new Error('unexpected endpoint')
  }) as typeof fetch
  const opener = async (input: string): Promise<void> => {
    const auth = new URL(input); scopes = auth.searchParams.get('scope')!.replace(' email ', ' https://www.googleapis.com/auth/userinfo.email ')
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256')
    const redirect = auth.searchParams.get('redirect_uri')!, state = auth.searchParams.get('state')!
    assert.equal((await fetch(`${redirect}?state=wrong&code=invalid`)).status, 400)
    assert.equal((await fetch(`${redirect}?state=${encodeURIComponent(state)}&code=fixture-code`)).status, 200)
  }
  setGoogleOAuthTransportForTests(mockFetch, opener)
  try {
    const input = '123456789-test.apps.googleusercontent.com'
    assert.deepEqual(await connectGoogle('gmail', input, 'fixture-secret'), { account: 'fixture@example.test' })
    assert.ok(observedPkce)
    const disk = await readFile(join(root, 'google-connections.json'), 'utf8')
    assert.ok(!disk.includes('fixture-secret') && !disk.includes('fixture-refresh'))
    assert.equal((await readGoogleCredentials('gmail'))?.account, 'fixture@example.test')
    assert.equal(await googleAccessToken('gmail'), 'fixture-access')
    assert.deepEqual(await verifyGoogleConnection('gmail'), { account: 'fixture@example.test' })
    failedService = true
    await assert.rejects(connectGoogle('gmail', input, 'different-secret'), /failed/)
    assert.equal((await readGoogleCredentials('gmail'))?.clientSecret, 'fixture-secret')
    await assert.rejects(verifyGoogleConnection('gmail'), /failed/)
    await removeGoogleCredentials('gmail')
    assert.equal(await readGoogleCredentials('gmail'), null)
  } finally { setGoogleOAuthTransportForTests(); setGoogleStorageForTests(undefined); await rm(root, { recursive: true, force: true }) }
})
