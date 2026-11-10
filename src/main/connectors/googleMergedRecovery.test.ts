import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { SafeStorage } from 'electron'
import type { ToolContext } from '../tools/types'
import { readGmailTool } from '../tools/agent/googleRead.ts'
import { connectGoogle, disconnectGoogle, GoogleSendNotStartedError, googleAccessToken, invalidateGoogleAccessToken, sendGmailRaw, setGoogleOAuthTransportForTests, verifyGoogleConnection } from './googleOAuth.ts'
import { addGoogleCredentials, googleAccountId, readGoogleCredentials, saveGoogleCredentials, setGoogleStorageForTests } from './googleSecrets.ts'
import { readGmail } from './googleRead.ts'

const scopes = ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send']
const emails = { A: 'account-a@example.test', B: 'account-b@example.test' }
const ids = { A: googleAccountId(emails.A), B: googleAccountId(emails.B) }
const grant = (name: 'A' | 'B') => ({ clientId: '123456789-fixture.apps.googleusercontent.com', refreshToken: `fixture-refresh-${name}-1`, scopes, account: emails[name] })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
const message = (name: string, html = false) => Response.json({ id: 'fixture_mail', payload: { mimeType: html ? 'text/html' : 'text/plain', body: { data: Buffer.from(html ? `<p>HTML body ${name} &amp; readable</p><script>hiddenScript()</script><img src="https://tracking.example.test/pixel">` : `body-${name}`).toString('base64url') } } })
const bearer = (init?: RequestInit) => (init?.headers as Record<string, string>).authorization.replace('Bearer ', '')
async function isolated(run: () => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'blinky-google-merged-')), previous = process.env.OPENBOT_DATA_DIR
  process.env.OPENBOT_DATA_DIR = root
  setGoogleStorageForTests({ isEncryptionAvailable: () => true, encryptString: (v: string) => Buffer.from([...v].reverse().join('')), decryptString: (v: Buffer) => [...v.toString()].reverse().join('') } as unknown as SafeStorage)
  try {
    invalidateGoogleAccessToken('gmail')
    await saveGoogleCredentials('gmail', grant('A')); await addGoogleCredentials('gmail', grant('B'))
    await run()
  } finally {
    invalidateGoogleAccessToken('gmail'); setGoogleOAuthTransportForTests(); setGoogleStorageForTests(undefined)
    if (previous === undefined) delete process.env.OPENBOT_DATA_DIR; else process.env.OPENBOT_DATA_DIR = previous
    await rm(root, { recursive: true, force: true })
  }
}

test('A late 401 cannot evict or refresh B, and A recovers on its own grant', async () => isolated(async () => {
  const entered = deferred<void>(), response = deferred<Response>(), refreshes = { A: 0, B: 0 }; let aReads = 0
  setGoogleOAuthTransportForTests((async (input, init) => {
    if (String(input).endsWith('/token')) {
      const name = (init!.body as URLSearchParams).get('refresh_token')!.includes('-A-') ? 'A' : 'B'
      return Response.json({ access_token: `access-${name}-${++refreshes[name]}`, expires_in: 3600 })
    }
    if (bearer(init).startsWith('access-A') && ++aReads === 1) { entered.resolve(); return response.promise }
    return message(bearer(init).startsWith('access-A') ? 'A' : 'B')
  }) as typeof fetch)
  const pending = readGmail('fixture_mail', undefined, ids.A); void pending.catch(() => {})
  try { await entered.promise; assert.equal((await readGmail('fixture_mail', undefined, ids.B)).text, 'body-B') }
  finally { response.resolve(new Response('', { status: 401 })) }
  assert.equal((await pending).text, 'body-A')
  assert.equal(await googleAccessToken('gmail', ids.B), 'access-B-1')
  assert.deepEqual(refreshes, { A: 2, B: 1 })
}))

test('a delayed old A 401 preserves the newer A token shared by concurrent readers', async () => isolated(async () => {
  const entered = deferred<void>(), response = deferred<Response>(); let refreshes = 0, reads = 0
  setGoogleOAuthTransportForTests((async (input) => {
    if (String(input).endsWith('/token')) return Response.json({ access_token: `access-A-${++refreshes}`, expires_in: 3600 })
    if (++reads === 1) { entered.resolve(); return response.promise }
    if (reads === 2) return new Response('', { status: 401 })
    return message('A')
  }) as typeof fetch)
  const first = readGmail('fixture_mail', undefined, ids.A); void first.catch(() => {})
  try { await entered.promise; assert.equal((await readGmail('fixture_mail', undefined, ids.A)).text, 'body-A') }
  finally { response.resolve(new Response('', { status: 401 })) }
  assert.equal((await first).text, 'body-A'); assert.equal(refreshes, 2); assert.equal(reads, 4)
}))

test('moving the default to B keeps a pending retry bound to still-connected A', async () => isolated(async () => {
  const entered = deferred<void>(), response = deferred<Response>(), used: string[] = []; let reads = 0
  setGoogleOAuthTransportForTests((async (input, init) => {
    if (String(input).endsWith('/token')) {
      const refresh = (init!.body as URLSearchParams).get('refresh_token')!; used.push(refresh)
      return Response.json({ access_token: refresh.includes('-A-') ? 'access-A' : 'access-B', expires_in: 3600 })
    }
    if (++reads === 1) { entered.resolve(); return response.promise }
    return message(bearer(init).endsWith('A') ? 'A' : 'B')
  }) as typeof fetch)
  const pending = readGmail('fixture_mail'); void pending.catch(() => {})
  try {
    await entered.promise
    await saveGoogleCredentials('gmail', grant('B')); await addGoogleCredentials('gmail', grant('A'))
  } finally { response.resolve(new Response('', { status: 401 })) }
  assert.equal((await pending).text, 'body-A')
  assert.deepEqual(used, ['fixture-refresh-A-1', 'fixture-refresh-A-1'])
  assert.equal((await readGmail('fixture_mail')).text, 'body-B')
}))

test('if A was removed when the default changed, recovery fails instead of using B', async () => isolated(async () => {
  const entered = deferred<void>(), response = deferred<Response>(), used: string[] = []; let reads = 0
  setGoogleOAuthTransportForTests((async (input, init) => {
    if (String(input).endsWith('/token')) { const refresh = (init!.body as URLSearchParams).get('refresh_token')!; used.push(refresh); return Response.json({ access_token: 'access-A', expires_in: 3600 }) }
    reads++; entered.resolve(); return response.promise
  }) as typeof fetch)
  const pending = readGmail('fixture_mail'); void pending.catch(() => {})
  try { await entered.promise; await saveGoogleCredentials('gmail', grant('B')) }
  finally { response.resolve(new Response('', { status: 401 })) }
  await assert.rejects(pending, /changed|connected/)
  assert.equal(reads, 1); assert.deepEqual(used, ['fixture-refresh-A-1'])
}))

test('recovery uses the latest rotated refresh token for the captured account', async () => isolated(async () => {
  let refreshes = 0, reads = 0
  setGoogleOAuthTransportForTests((async (input, init) => {
    if (String(input).endsWith('/token')) {
      assert.equal((init!.body as URLSearchParams).get('refresh_token'), `fixture-refresh-A-${refreshes + 1}`)
      refreshes++
      return Response.json({ access_token: `access-A-${refreshes}`, refresh_token: `fixture-refresh-A-${refreshes + 1}`, expires_in: 3600 })
    }
    return ++reads === 1 ? new Response('', { status: 401 }) : message('A')
  }) as typeof fetch)
  assert.equal((await readGmail('fixture_mail', undefined, ids.A)).text, 'body-A')
  assert.equal((await readGoogleCredentials('gmail', ids.A))?.refreshToken, 'fixture-refresh-A-3')
  assert.equal(refreshes, 2)
}))

test('read recovery is bounded to one 401 and never replays permission or server errors', async () => {
  for (const status of [401, 403, 429, 500]) await isolated(async () => {
    let refreshes = 0, reads = 0
    setGoogleOAuthTransportForTests((async input => {
      if (String(input).endsWith('/token')) return Response.json({ access_token: `access-${++refreshes}`, expires_in: 3600 })
      reads++; return new Response('', { status })
    }) as typeof fetch)
    await assert.rejects(readGmail('fixture_mail', undefined, ids.A), /failed/)
    assert.equal(reads, status === 401 ? 2 : 1); assert.equal(refreshes, status === 401 ? 2 : 1)
  })
})

test('beforePost refusal after refresh and a throwing fence both result in zero sends', async () => isolated(async () => {
  const entered = deferred<void>(), token = deferred<Response>(); let stopped = false, posts = 0, fences = 0
  setGoogleOAuthTransportForTests((async input => {
    if (String(input).endsWith('/token')) { entered.resolve(); return token.promise }
    posts++; return Response.json({ id: 'must-not-send' })
  }) as typeof fetch)
  const pending = sendGmailRaw('fixture-raw', emails.A, ids.A, () => { fences++; return !stopped }); void pending.catch(() => {})
  await entered.promise; stopped = true; token.resolve(Response.json({ access_token: 'access-A', expires_in: 3600 }))
  await assert.rejects(pending, error => error instanceof GoogleSendNotStartedError && error.code === 'google_send_not_started')
  await assert.rejects(sendGmailRaw('fixture-raw', emails.A, ids.A, () => { fences++; throw Error('fixture fence error') }), error => error instanceof GoogleSendNotStartedError)
  assert.equal(posts, 0); assert.equal(fences, 2)
}))

test('a send 401 never replays the POST, invalidates only A and preserves B', async () => isolated(async () => {
  const refreshes = { A: 0, B: 0 }; let posts = 0, fences = 0
  setGoogleOAuthTransportForTests((async (input, init) => {
    if (String(input).endsWith('/token')) { const name = (init!.body as URLSearchParams).get('refresh_token')!.includes('-A-') ? 'A' : 'B'; return Response.json({ access_token: `access-${name}-${++refreshes[name]}`, expires_in: 3600 }) }
    assert.equal(init!.method, 'POST'); posts++; return new Response('', { status: 401 })
  }) as typeof fetch)
  await googleAccessToken('gmail', ids.B)
  await assert.rejects(sendGmailRaw('fixture-raw', emails.A, ids.A, () => { fences++; return true }), /failed/)
  assert.equal(posts, 1); assert.equal(fences, 1)
  assert.equal(await googleAccessToken('gmail', ids.A), 'access-A-2')
  assert.equal(await googleAccessToken('gmail', ids.B), 'access-B-1'); assert.deepEqual(refreshes, { A: 2, B: 1 })
}))

test('an OAuth error callback with code cannot replace either selected or default grant', async () => isolated(async () => {
  let exchanges = 0
  setGoogleOAuthTransportForTests((async () => { exchanges++; throw Error('No token exchange should occur') }) as typeof fetch, async value => {
    const auth = new URL(value), callback = new URL(auth.searchParams.get('redirect_uri')!)
    callback.searchParams.set('state', auth.searchParams.get('state')!); callback.searchParams.set('code', 'fixture-code'); callback.searchParams.set('error', 'access_denied')
    assert.equal((await fetch(callback)).status, 200)
  })
  await assert.rejects(connectGoogle('gmail', '', '', { accountId: ids.B }), /declined/)
  assert.equal(exchanges, 0)
  assert.deepEqual(await readGoogleCredentials('gmail'), grant('A'))
  assert.deepEqual(await readGoogleCredentials('gmail', ids.B), grant('B'))
}))

test('the current account-aware read tool recovers B then projects HTML-only text without loading resources', async () => isolated(async () => {
  let refreshes = 0, reads = 0
  setGoogleOAuthTransportForTests((async (input, init) => {
    if (String(input).endsWith('/token')) { assert.equal((init!.body as URLSearchParams).get('refresh_token'), grant('B').refreshToken); return Response.json({ access_token: `access-B-${++refreshes}`, expires_in: 3600 }) }
    return ++reads === 1 ? new Response('', { status: 401 }) : message('B', true)
  }) as typeof fetch)
  const ctx = { sessionId: 'fixture', botId: 'fixture', signal: new AbortController().signal, callId: 'fixture-call' } as ToolContext
  const result = await readGmailTool.handler({ message_id: 'fixture_mail', account_id: ids.B }, ctx)
  assert.equal(result.ok, true); assert.match(result.output, /HTML body B & readable/); assert.match(result.output, /html-text/)
  assert.ok(!/tracking|hiddenScript/.test(result.output)); assert.equal(refreshes, 2); assert.equal(reads, 2)
}))

test('connection verification retries userinfo and profile using the same selected binding', async () => isolated(async () => {
  let refreshes = 0, identities = 0, profiles = 0
  setGoogleOAuthTransportForTests((async (input, init) => {
    if (String(input).endsWith('/token')) { assert.equal((init!.body as URLSearchParams).get('refresh_token'), grant('B').refreshToken); return Response.json({ access_token: `access-B-${++refreshes}`, expires_in: 3600 }) }
    if (String(input).endsWith('/userinfo')) return ++identities === 1 ? new Response('', { status: 401 }) : Response.json({ email: emails.B, email_verified: true })
    profiles++; return profiles === 1 ? new Response('', { status: 401 }) : Response.json({ emailAddress: emails.B })
  }) as typeof fetch)
  assert.deepEqual(await verifyGoogleConnection('gmail', ids.B), { account: emails.B })
  assert.equal(identities, 2); assert.equal(profiles, 2); assert.equal(refreshes, 3)
}))

test('disconnect during a rejected A read cancels recovery while B remains usable', async () => isolated(async () => {
  const refreshes = { A: 0, B: 0 }; let aReads = 0
  setGoogleOAuthTransportForTests((async (input, init) => {
    if (String(input).endsWith('/token')) { const name = (init!.body as URLSearchParams).get('refresh_token')!.includes('-A-') ? 'A' : 'B'; return Response.json({ access_token: `access-${name}-${++refreshes[name]}`, expires_in: 3600 }) }
    if (bearer(init).startsWith('access-A')) { aReads++; await disconnectGoogle('gmail', ids.A); return new Response('', { status: 401 }) }
    return message('B')
  }) as typeof fetch)
  await assert.rejects(readGmail('fixture_mail', undefined, ids.A), /changed|stopped|disconnect/)
  assert.equal(aReads, 1); assert.equal(refreshes.A, 1)
  assert.equal((await readGmail('fixture_mail', undefined, ids.B)).text, 'body-B')
}))
