import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { build } from 'electron-vite'
import { SLACK_REDIRECT, SLACK_USER_SCOPES } from './slackOAuth.ts'

test('publisher Slack manifest matches the implemented public user authorization contract', async () => {
  const manifest = JSON.parse(await readFile('src/main/connectors/registration/slack-user-manifest.json', 'utf8'))
  assert.deepEqual(manifest.oauth_config.redirect_urls, [SLACK_REDIRECT])
  assert.deepEqual(manifest.oauth_config.scopes.user, SLACK_USER_SCOPES)
  assert.equal(manifest.oauth_config.scopes.bot, undefined)
  assert.equal(manifest.oauth_config.pkce_enabled, true)
  assert.equal(manifest.settings.socket_mode_enabled, false)
  assert.equal(manifest.settings.token_rotation_enabled, true)
})

test('electron-vite embeds only distributor fixture clients into a temporary main bundle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-client-build-'))
  const fixture = {
    MAIN_VITE_GOOGLE_CLIENT_ID: '123456789-fixture.apps.googleusercontent.com',
    MAIN_VITE_GOOGLE_CLIENT_SECRET: 'fixture-native-secret', MAIN_VITE_X_CLIENT_ID: 'fixture-native-x-client', MAIN_VITE_SLACK_CLIENT_ID: '123456.789012',
    MAIN_VITE_GITHUB_CLIENT_ID: 'Iv1.fixtureClient123', MAIN_VITE_GITHUB_CLIENT_SECRET: 'fixture-github-secret'
  }
  for (const [key, value] of Object.entries(fixture)) process.env[key] = value
  try {
    const configFile = join(root, 'electron.config.mjs'), outDir = join(root, 'out')
    // electron-vite's build accepts a Vite InlineConfig, not a nested main
    // object. Supplying an actual config file makes this a real build check.
    await writeFile(configFile, `export default {main:{envDir:${JSON.stringify(root)},build:{outDir:${JSON.stringify(outDir)},lib:{entry:${JSON.stringify(resolve('src/main/connectors/oauthClients.ts'))},formats:['es']},rollupOptions:{output:{entryFileNames:'oauthClients.mjs'}}}}}`)
    await build({ configFile, envFile: false, logLevel: 'error' })
    assert.ok((await readdir(outDir)).includes('oauthClients.mjs'), 'Main bundle was not generated: ' + (await readdir(outDir)).join(', '))
    const text = await readFile(join(outDir, 'oauthClients.mjs'), 'utf8')
    for (const value of Object.values(fixture)) assert.ok(text.includes(value))
    const clients = await import(pathToFileURL(join(outDir, 'oauthClients.mjs')))
    assert.deepEqual(clients.googleClient(), { clientId: fixture.MAIN_VITE_GOOGLE_CLIENT_ID, clientSecret: fixture.MAIN_VITE_GOOGLE_CLIENT_SECRET })
    assert.equal(clients.xClientId(), fixture.MAIN_VITE_X_CLIENT_ID)
    assert.equal(clients.slackClientId(), fixture.MAIN_VITE_SLACK_CLIENT_ID)
    assert.deepEqual(clients.githubClient(), { clientId: fixture.MAIN_VITE_GITHUB_CLIENT_ID, clientSecret: fixture.MAIN_VITE_GITHUB_CLIENT_SECRET })
  } finally {
    for (const key of Object.keys(fixture)) delete process.env[key]
    await rm(root, { recursive: true, force: true })
  }
})

test('a main bundle built without publisher env does not invent clients', async () => {
  const keys = ['MAIN_VITE_GOOGLE_CLIENT_ID', 'MAIN_VITE_GOOGLE_CLIENT_SECRET', 'MAIN_VITE_X_CLIENT_ID', 'MAIN_VITE_GITHUB_CLIENT_ID', 'MAIN_VITE_GITHUB_CLIENT_SECRET']
  const previous = new Map(keys.map((key) => [key, process.env[key]]))
  for (const key of keys) delete process.env[key]
  const root = await mkdtemp(join(tmpdir(), 'blinky-client-missing-'))
  try {
    const configFile = join(root, 'electron.config.mjs'), outDir = join(root, 'out')
    await writeFile(configFile, `export default {main:{envDir:${JSON.stringify(root)},build:{outDir:${JSON.stringify(outDir)},lib:{entry:${JSON.stringify(resolve('src/main/connectors/oauthClients.ts'))},formats:['es']},rollupOptions:{output:{entryFileNames:'oauthClients.mjs'}}}}}`)
    await build({ configFile, envFile: false, logLevel: 'error' })
    const clients = await import(pathToFileURL(join(outDir, 'oauthClients.mjs')))
    assert.equal(clients.googleClient(), undefined)
    assert.equal(clients.xClientId(), undefined)
    assert.equal(clients.githubClient(), undefined)
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  }
})
