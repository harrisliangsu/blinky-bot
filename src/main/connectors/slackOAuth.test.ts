import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { SafeStorage } from 'electron'
import { createBot } from '../store/bots.ts'
import { flushAll } from '../store/jsonStore.ts'
import { connectSlack, invalidateSlackRequests, postSlackMessage, setSlackTransportForTests, verifySlackConnection } from './slackApi.ts'
import { invalidateSlackOAuth, setSlackOAuthTransportForTests, SLACK_REDIRECT, SLACK_USER_SCOPES, slackUserAccessToken } from './slackOAuth.ts'
import { clearSlackCredentials, readSlackCredentials, saveSlackCredentials, setSlackStorageForTests } from './slackSecrets.ts'
import { parseSlackEvent } from './slackInboxStore.ts'

const storage = { isEncryptionAvailable: () => true, encryptString: (v: string) => Buffer.from([...v].reverse().join('')), decryptString: (v: Buffer) => [...v.toString()].reverse().join('') } as unknown as SafeStorage

test('Slack browser user grant, existing send path, errors, compatibility and disconnect', { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'slack-user-oauth-')), oldRoot = process.env.OPENBOT_DATA_DIR
  process.env.OPENBOT_DATA_DIR = root
  setSlackStorageForTests(storage)
  const bot = createBot({ name: 'Fixture', backendId: 'codex', modelId: 'fixture', followsDefault: false })
  const input = { appToken: '', botToken: '', allowedUserId: '', channelId: 'C123', botId: bot.id }
  let opens = 0, sent = 0, sockets = 0, denied = false, badScopes = false, refreshes = 0, challenge = ''
  const access = 'xoxe.xoxp-fixture-user-access'
  setSlackTransportForTests((async (url, init) => {
    const method = String(url).split('/').at(-1)
    if (denied) return Response.json({ ok: false, error: 'missing_scope' })
    if (method === 'apps.connections.open') { sockets++; return Response.json({ ok: true, url: 'wss://wss.slack.com/fixture' }) }
    if (method === 'auth.test') { assert.equal((init?.headers as Record<string,string>).authorization, `Bearer ${access}`); return Response.json({ ok: true, team_id: 'T123', user_id: 'U123' }) }
    if (method === 'conversations.info') return Response.json({ ok: true, channel: { id: 'C123', is_member: true } })
    if (method === 'chat.postMessage') { sent++; assert.equal((init?.headers as Record<string,string>).authorization, `Bearer ${access}`); return Response.json({ ok: true, channel: 'C123', ts: '123.456' }) }
    throw new Error('Unexpected fixture method')
  }) as typeof fetch)
  setSlackOAuthTransportForTests((async (_url, init) => {
    const body = init?.body as URLSearchParams
    assert.equal(body.has('client_secret'), false)
    if (body.get('grant_type') === 'refresh_token') { refreshes++; return Response.json({ ok: true, token_type: 'user', access_token: access, refresh_token: 'fixture-rotated-refresh', expires_in: 3600, scope: SLACK_USER_SCOPES.join(',') }) }
    assert.equal(createHash('sha256').update(body.get('code_verifier')!).digest('base64url'), challenge)
    return Response.json({ ok: true, team: { id: 'T123' }, authed_user: { id: 'U123', token_type: 'user', access_token: access, refresh_token: 'fixture-refresh', expires_in: 3600, scope: badScopes ? 'chat:write' : SLACK_USER_SCOPES.join(',') } })
  }) as typeof fetch, async (value) => {
    opens++; const url = new URL(value)
    assert.equal(url.hostname, 'slack.com'); assert.equal(url.searchParams.get('scope'), '')
    assert.equal(url.searchParams.get('user_scope'), SLACK_USER_SCOPES.join(',')); assert.equal(url.searchParams.get('redirect_uri'), SLACK_REDIRECT)
    challenge = url.searchParams.get('code_challenge')!
    assert.equal((await fetch(`${SLACK_REDIRECT}?state=wrong&code=invalid`)).status, 400)
    assert.equal((await fetch(`${SLACK_REDIRECT}?state=${url.searchParams.get('state')}&code=fixture-code`)).status, 200)
  })
  try {
    await t.test('missing distributor registration does not open browser or ask user for a token', async () => {
      delete process.env.BLINKY_SLACK_CLIENT_ID
      await assert.rejects(connectSlack(input), /registered Slack public client/); assert.equal(opens, 0)
    })
    await t.test('PKCE uses user scopes, stores encrypted state and reaches the existing post adapter', async () => {
      process.env.BLINKY_SLACK_CLIENT_ID = '123456.789012'
      await connectSlack(input); delete process.env.BLINKY_SLACK_CLIENT_ID
      const saved = (await readSlackCredentials())!
      assert.equal(saved.appToken, ''); assert.equal(saved.oauth?.clientId, '123456.789012'); assert.equal(saved.botUserId, 'U123')
      assert.ok(!(await readFile(join(root, 'slack-connection.json'), 'utf8')).includes(access))
      await verifySlackConnection(); assert.equal(sockets, 0); assert.equal(sent, 0)
      await postSlackMessage({ teamId: 'T123', botUserId: 'U123', channelId: 'C123' }, 'Fixture review confirmed')
      assert.equal(sent, 1)
      assert.equal(parseSlackEvent(saved, {}), null)
    })
    await t.test('missing scopes and API denial preserve old grant and never report success', async () => {
      const before = await readFile(join(root, 'slack-connection.json'), 'utf8')
      badScopes = true; await assert.rejects(connectSlack(input), /required user permissions/); badScopes = false
      assert.equal(await readFile(join(root, 'slack-connection.json'), 'utf8'), before)
      denied = true; await assert.rejects(verifySlackConnection(), /authorize/); denied = false
      await assert.rejects(postSlackMessage({ teamId: 'TOTHER', botUserId: 'U123', channelId: 'C123' }, 'Wrong account'), /changed/)
      assert.equal(sent, 1)
    })
    await t.test('rotating refresh is persisted before use and disconnect defeats late refresh', async () => {
      const saved = (await readSlackCredentials())!
      await saveSlackCredentials({ ...saved, oauth: { ...saved.oauth!, expiresAt: 1 } })
      assert.equal(await slackUserAccessToken(), access); assert.equal(refreshes, 1)
      assert.equal((await readSlackCredentials())?.oauth?.refreshToken, 'fixture-rotated-refresh')
      await saveSlackCredentials({ ...(await readSlackCredentials())!, oauth: { ...(await readSlackCredentials())!.oauth!, expiresAt: 1 } })
      let resolve!: (r: Response) => void, entered!: () => void
      const pending = new Promise<void>((r) => { entered = r })
      setSlackOAuthTransportForTests((async () => { entered(); return new Promise<Response>((r) => { resolve = r }) }) as typeof fetch)
      const request = slackUserAccessToken(); void request.catch(() => undefined)
      await pending; invalidateSlackRequests(); await clearSlackCredentials()
      resolve(Response.json({ ok: true, token_type: 'user', access_token: access, refresh_token: 'late-refresh', expires_in: 3600 }))
      await assert.rejects(request, /changed/)
      assert.equal(await readSlackCredentials(), null)
    })
    await t.test('cancelling pending browser authorization closes it without creating credentials', async () => {
      process.env.BLINKY_SLACK_CLIENT_ID = '123456.789012'
      let entered!: () => void
      const opened = new Promise<void>((r) => { entered = r })
      setSlackOAuthTransportForTests(undefined, async () => { entered(); await new Promise<void>(() => {}) })
      const connecting = connectSlack(input); void connecting.catch(() => undefined)
      await opened; invalidateSlackRequests()
      await assert.rejects(connecting, /cancelled/)
      assert.equal(await readSlackCredentials(), null)
      delete process.env.BLINKY_SLACK_CLIENT_ID
    })
    await t.test('legacy Socket Mode encrypted records remain readable and disconnect is persistent', async () => {
      const legacy = { appToken: 'xapp-fixture-token', botToken: 'xoxb-fixture-token', allowedUserId: 'U123', channelId: 'C123', botId: bot.id, teamId: 'T123', botUserId: 'UBOT' }
      await saveSlackCredentials(legacy)
      assert.deepEqual(await readSlackCredentials(), legacy)
      invalidateSlackRequests(); await clearSlackCredentials(); assert.equal(await readSlackCredentials(), null)
    })
  } finally {
    delete process.env.BLINKY_SLACK_CLIENT_ID; invalidateSlackOAuth(); setSlackOAuthTransportForTests(); setSlackTransportForTests(); setSlackStorageForTests(undefined)
    await flushAll(); process.env.OPENBOT_DATA_DIR = oldRoot
    await rm(root, { recursive: true, force: true })
  }
})
