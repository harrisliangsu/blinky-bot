import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SafeStorage } from 'electron'
import { addGoogleCredentials, googleAccountId, listGoogleAccounts, readGoogleCredentials, saveGoogleCredentials, setGoogleStorageForTests } from './googleSecrets.ts'
import { connectGoogle, disconnectGoogle, GoogleSendNotStartedError, googleAccessToken, invalidateGoogleAccessToken, sendGmailRaw, setGoogleOAuthTransportForTests } from './googleOAuth.ts'
import { listCalendarEvents, readGmail, searchGmail } from './googleRead.ts'
import { gmailQueryFingerprint } from './gmailWatch.ts'

const scopes = ['openid','email','https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send']
const storage = { isEncryptionAvailable: () => true, encryptString: (v: string) => Buffer.from([...v].reverse().join('')), decryptString: (v: Buffer) => [...v.toString()].reverse().join('') } as unknown as SafeStorage
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }

test('four Google accounts isolate token refresh, mailbox, sends, watches and disconnects', { timeout: 15000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-google-four-')), previous = process.env.OPENBOT_DATA_DIR
  process.env.OPENBOT_DATA_DIR = root; setGoogleStorageForTests(storage)
  const emails = [1,2,3,4,5].map(n => `account${n}@example.test`), ids = emails.map(googleAccountId)
  const grant = (n: number, service = 'gmail') => ({ clientId: '123456789-fixture.apps.googleusercontent.com', refreshToken: `fixture-${service}-${n}`, account: emails[n - 1]!, scopes: service === 'gmail' ? scopes : ['openid','email','https://www.googleapis.com/auth/calendar.events'] })
  const refreshed = new Map<string, number>(), gates = new Map<string, ReturnType<typeof deferred<void>>>(), posts: string[] = [], reads: string[] = []
  let authorizing = 5, requestedScopes = '', observedPrompt = '', observedHint: string | null = null
  setGoogleOAuthTransportForTests((async (input, init) => {
    const url = new URL(String(input)), body = init?.body as URLSearchParams
    if (url.pathname === '/token') {
      if (body.get('grant_type') === 'authorization_code') return Response.json({ access_token: `fixture-access-gmail-${authorizing}`, refresh_token: `fixture-gmail-${authorizing}`, scope: requestedScopes })
      const refresh = body.get('refresh_token')!, key = refresh.replace('fixture-', '')
      refreshed.set(key, (refreshed.get(key) ?? 0) + 1)
      await gates.get(key)?.promise
      return Response.json({ access_token: 'fixture-access-' + key, expires_in: 3600 })
    }
    const token = String((init?.headers as Record<string,string>)?.authorization ?? '').replace('Bearer fixture-access-', '')
    const n = Number(token.split('-').at(-1)), email = emails[n - 1]!
    if (url.pathname === '/v1/userinfo') return Response.json({ email, email_verified: true })
    if (url.pathname.endsWith('/profile')) return Response.json({ emailAddress: email })
    if (url.pathname.endsWith('/messages/send')) { posts.push(token); return Response.json({ id: 'fixture-sent-' + n }) }
    if (url.pathname.includes('/calendar/v3/')) { assert.ok(token.startsWith('calendar-')); return Response.json({ items: [{ id: 'event', summary: email }] }) }
    assert.ok(token.startsWith('gmail-')); reads.push(token)
    if (url.pathname.endsWith('/messages')) return Response.json({ messages: [{ id: 'mail_' + n }] })
    assert.ok(url.pathname.endsWith('/mail_' + n), 'message identifiers cannot be read in another mailbox')
    return Response.json({ id: 'mail_' + n, payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value: email }], body: { data: Buffer.from('Fixture body ' + email).toString('base64url') } } })
  }) as typeof fetch, async value => {
    const url = new URL(value), callback = new URL(url.searchParams.get('redirect_uri')!)
    observedPrompt = url.searchParams.get('prompt') ?? ''; observedHint = url.searchParams.get('login_hint')
    requestedScopes = url.searchParams.get('scope')!; callback.searchParams.set('state', url.searchParams.get('state')!); callback.searchParams.set('code', 'fixture-code')
    await fetch(callback)
  })
  try {
    await t.test('legacy reads never migrate; explicit additions retain four encrypted grants and one default', async () => {
      await saveGoogleCredentials('gmail', grant(1))
      const before = await readFile(join(root, 'google-connections.json'), 'utf8')
      await listGoogleAccounts('gmail'); await readGoogleCredentials('gmail', ids[0])
      assert.equal(await readFile(join(root, 'google-connections.json'), 'utf8'), before)
      assert.equal(JSON.parse(before).version, 1)
      for (const n of [2,3,4]) assert.equal(await addGoogleCredentials('gmail', grant(n)), ids[n - 1])
      const stored = await readFile(join(root, 'google-connections.json'), 'utf8')
      assert.equal(JSON.parse(stored).version, 2)
      assert.ok(!stored.includes('fixture-gmail-'))
      assert.equal((await listGoogleAccounts('gmail')).length, 4)
      assert.equal((await readGoogleCredentials('gmail'))?.account, emails[0])
      assert.throws(() => { if (JSON.parse(stored).version !== 1) throw Error('Legacy binary rejects unsupported store') }, /rejects/)
    })
    await t.test('default alias and explicit same ID share one refresh; other accounts refresh independently', async () => {
      for (const n of [1,2,3,4]) gates.set('gmail-' + n, deferred<void>())
      const pending = [googleAccessToken('gmail'), googleAccessToken('gmail', ids[0]), ...ids.slice(0,4).map(id => googleAccessToken('gmail', id))]
      while ([1,2,3,4].some(n => !refreshed.get('gmail-' + n))) await new Promise(resolve => setImmediate(resolve))
      for (const n of [1,2,3,4]) { assert.equal(refreshed.get('gmail-' + n), 1); gates.get('gmail-' + n)!.resolve() }
      const tokens = await Promise.all(pending)
      assert.equal(tokens[0], tokens[1]); assert.equal(tokens[1], tokens[2])
      gates.clear()
    })
    await t.test('four concurrent searches, reads, watches and sends stay on the chosen identities', async () => {
      const results = await Promise.all(ids.slice(0,4).map(id => searchGmail('', 1, undefined, undefined, id)))
      results.forEach((value, i) => assert.equal(value.messages[0]?.subject, emails[i]))
      const bodies = await Promise.all(ids.slice(0,4).map((id, i) => readGmail('mail_' + (i + 1), undefined, id)))
      bodies.forEach((value, i) => assert.equal(value.text, 'Fixture body ' + emails[i]))
      const fingerprints = await Promise.all(ids.slice(0,4).map((id, i) => gmailQueryFingerprint('', emails[i]!, id)))
      assert.equal(new Set(fingerprints).size, 4)
      await Promise.all(ids.slice(0,4).map((id, i) => sendGmailRaw('fixture-raw', emails[i]!, id)))
      assert.deepEqual([...posts].sort(), ['gmail-1','gmail-2','gmail-3','gmail-4'])
      await assert.rejects(sendGmailRaw('fixture-raw', emails[1]!, ids[0]), /account changed/)
      assert.equal(posts.length, 4)
    })
    await t.test('the same account has separate Gmail and Calendar grants and tokens', async () => {
      await saveGoogleCredentials('calendar', grant(1, 'calendar')); await addGoogleCredentials('calendar', grant(2, 'calendar'))
      const result = await listCalendarEvents('2026-11-06T00:00:00Z', '2026-11-07T00:00:00Z', 1, undefined, undefined, ids[1])
      assert.equal(result.events[0]?.summary, emails[1]); assert.equal(refreshed.get('calendar-2'), 1)
      assert.equal((await readGoogleCredentials('gmail', ids[1]))?.refreshToken, 'fixture-gmail-2')
    })
    await t.test('disconnecting one pending refresh rejects it while the neighboring account continues', async () => {
      for (const n of [2,3]) { invalidateGoogleAccessToken('gmail', ids[n - 1]); gates.set('gmail-' + n, deferred<void>()) }
      const b = googleAccessToken('gmail', ids[1]); void b.catch(() => {})
      const c = googleAccessToken('gmail', ids[2])
      while ((refreshed.get('gmail-2') ?? 0) < 2 || (refreshed.get('gmail-3') ?? 0) < 2) await new Promise(resolve => setImmediate(resolve))
      const removed = disconnectGoogle('gmail', ids[1]); gates.get('gmail-2')!.resolve(); gates.get('gmail-3')!.resolve()
      await assert.rejects(b, /changed/); assert.equal(await c, 'fixture-access-gmail-3'); await removed; gates.clear()
      assert.equal(await readGoogleCredentials('gmail', ids[1]), null)
      assert.equal((await readGoogleCredentials('gmail'))?.account, emails[0])
      assert.equal((await searchGmail('',1,undefined,undefined,ids[3])).messages[0]?.subject, emails[3])
    })
    await t.test('disconnecting default invalidates its explicit alias without falling back to other accounts', async () => {
      invalidateGoogleAccessToken('gmail', ids[0]); gates.set('gmail-1', deferred<void>())
      const pending = googleAccessToken('gmail', ids[0]); void pending.catch(() => {})
      while ((refreshed.get('gmail-1') ?? 0) < 2) await new Promise(resolve => setImmediate(resolve))
      const removed = disconnectGoogle('gmail'); gates.get('gmail-1')!.resolve()
      await assert.rejects(pending, /changed/); await removed; gates.clear()
      assert.equal(await readGoogleCredentials('gmail'), null)
      await assert.rejects(searchGmail('', 1), /not connected/)
      assert.equal((await searchGmail('',1,undefined,undefined,ids[2])).messages[0]?.subject, emails[2])
    })
    await t.test('default reconnect replaces only default, while selected account reauth rejects a different identity', async () => {
      await saveGoogleCredentials('gmail', grant(1))
      await connectGoogle('gmail')
      assert.equal((await readGoogleCredentials('gmail'))?.account, emails[4])
      assert.equal(await readGoogleCredentials('gmail', ids[0]), null)
      assert.equal((await readGoogleCredentials('gmail', ids[2]))?.account, emails[2])
      await assert.rejects(connectGoogle('gmail', '', '', { accountId: ids[2] }), /different Google account/)
      assert.equal(observedHint, emails[2])
      assert.equal((await readGoogleCredentials('gmail', ids[2]))?.account, emails[2])
    })
    await t.test('explicit add requests an account chooser and the same identity remains one slot', async () => {
      authorizing = 3
      const before = (await listGoogleAccounts('gmail')).length
      await connectGoogle('gmail', '', '', { addAccount: true })
      assert.equal(observedPrompt, 'consent select_account'); assert.equal(observedHint, null)
      assert.equal((await listGoogleAccounts('gmail')).length, before)
      assert.equal((await readGoogleCredentials('gmail'))?.account, emails[4])
    })
    await t.test('a stop after token refresh begins is a definite zero-POST refusal', async () => {
      invalidateGoogleAccessToken('gmail', ids[2]); gates.set('gmail-3', deferred<void>())
      let stopped = false; const before = posts.length
      const pending = sendGmailRaw('fixture-raw', emails[2]!, ids[2], () => !stopped)
      while ((refreshed.get('gmail-3') ?? 0) < 3) await new Promise(resolve => setImmediate(resolve))
      stopped = true; gates.get('gmail-3')!.resolve()
      await assert.rejects(pending, error => error instanceof GoogleSendNotStartedError && error.code === 'google_send_not_started')
      assert.equal(posts.length, before); gates.clear()
    })
  } finally {
    for (const gate of gates.values()) gate.resolve()
    invalidateGoogleAccessToken('gmail'); invalidateGoogleAccessToken('calendar'); setGoogleOAuthTransportForTests(); setGoogleStorageForTests(undefined)
    if (previous === undefined) delete process.env.OPENBOT_DATA_DIR; else process.env.OPENBOT_DATA_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
})
