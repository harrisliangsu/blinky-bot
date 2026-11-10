import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { SafeStorage } from 'electron'
import { invalidateGoogleAccessToken, setGoogleOAuthTransportForTests } from './googleOAuth.ts'
import { saveGoogleCredentials, setGoogleStorageForTests } from './googleSecrets.ts'
import { listCalendarEvents, readGmail, searchGmail } from './googleRead.ts'

test('Gmail and calendar tools read bounded data through the correct Google account scopes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-google-read-')); process.env.OPENBOT_DATA_DIR = root
  setGoogleStorageForTests({ isEncryptionAvailable: () => true, encryptString: (v: string) => Buffer.from(v), decryptString: (v: Buffer) => v.toString() } as unknown as SafeStorage)
  const base = { clientId: '123456789-test.apps.googleusercontent.com', refreshToken: 'fixture-refresh', account: 'fixture@example.test' }
  await saveGoogleCredentials('gmail', { ...base, scopes: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'] })
  await saveGoogleCredentials('calendar', { ...base, scopes: ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events'] })
  const seen: string[] = []; let refreshes = 0
  setGoogleOAuthTransportForTests((async (input: string | URL | Request) => {
    const url = new URL(String(input)); seen.push(url.origin + url.pathname)
    if (url.href === 'https://oauth2.googleapis.com/token') { refreshes++; return Response.json({ access_token: 'fixture-access', expires_in: 3600 }) }
    if (url.pathname === '/gmail/v1/users/me/messages') { assert.equal(url.searchParams.get('q'), 'subject:test'); return Response.json({ messages: [{ id: 'abc123' }], ...(url.searchParams.has('pageToken') ? {} : { nextPageToken: 'mail-next' }) }) }
    if (url.pathname === '/gmail/v1/users/me/messages/abc123') return Response.json({ id:'abc123',threadId:'thread',snippet:'preview',payload:{mimeType:'text/plain',headers:[{name:'From',value:'fixture@example.test'},{name:'Subject',value:'Example'}],body:{data:Buffer.from('fixture body').toString('base64url')}} })
    if (url.pathname === '/calendar/v3/calendars/primary/events') return Response.json({ items:[{ id:'event', summary:'Fixture', start:{dateTime:'2026-11-06T09:00:00Z'},end:{dateTime:'2026-11-06T10:00:00Z'} }], ...(url.searchParams.has('pageToken') ? {} : { nextPageToken: 'event-next' }) })
    throw new Error('unexpected Google endpoint')
  }) as typeof fetch)
  try {
    const mail = await searchGmail('subject:test', 5); assert.equal(mail.messages[0]?.subject, 'Example'); assert.equal(mail.nextPageToken, 'mail-next')
    assert.equal((await searchGmail('subject:test', 5, undefined, mail.nextPageToken)).nextPageToken, undefined)
    assert.equal((await readGmail('abc123')).text, 'fixture body')
    assert.equal(refreshes, 1, 'concurrent Gmail API calls should share the cached access token')
    const events = await listCalendarEvents('2026-11-06T00:00:00Z', '2026-11-07T00:00:00Z', 10); assert.equal(events.events[0]?.summary, 'Fixture'); assert.equal(events.nextPageToken, 'event-next')
    assert.equal((await listCalendarEvents('2026-11-06T00:00:00Z', '2026-11-07T00:00:00Z', 10, undefined, events.nextPageToken)).nextPageToken, undefined)
    await assert.rejects(listCalendarEvents('2026-11-06', '2026-11-07', 10), /time zones/)
    await assert.rejects(readGmail('../bad'), /Invalid message identifier/)
    assert.ok(seen.every((value) => value.startsWith('https://gmail.googleapis.com/') || value.startsWith('https://www.googleapis.com/') || value === 'https://oauth2.googleapis.com/token'))
  } finally { invalidateGoogleAccessToken('gmail'); invalidateGoogleAccessToken('calendar'); setGoogleOAuthTransportForTests(); setGoogleStorageForTests(undefined); await rm(root,{recursive:true,force:true}) }
})
