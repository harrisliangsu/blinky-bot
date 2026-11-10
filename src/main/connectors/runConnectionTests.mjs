import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { connectionTestEnvironment } from './testEnvironment.mjs'

if (process.versions.electron) throw new Error('Use the Node CLI, not an Electron process, for connector tests.')
if (process.argv.slice(2).some((arg) => arg !== '--cli-only')) throw new Error('Only --cli-only is supported. Local desktop tests remain suspended.')
console.log('CLI-only connector checks: native Electron tests are suspended and desktop process launches are blocked.')
const root = await mkdtemp(path.join(tmpdir(), 'blinky-connector-suite-'))
try {
  const env = await connectionTestEnvironment(root)
  const files = [
    'src/main/connectors/connectionLifecycle.test.ts', 'src/main/connectors/githubConnection.test.ts',
    'src/main/connectors/githubOAuth.test.ts',
    'src/main/connectors/oauthClientBuild.test.mjs',
    'src/main/connectors/slackOAuth.test.ts',
    'src/main/connectors/oauthRefresh.test.ts',
    'src/main/connectors/restartAndTools.test.mjs',
    'src/main/connectors/desktopTestSafety.test.mjs',
    'src/renderer/src/components/SettingsAppsConnections.test.mjs',
    'src/main/connectors/googleOAuth.test.ts', 'src/main/connectors/googleRead.test.ts',
    'src/main/connectors/gmailMime.test.ts', 'src/main/connectors/xOAuth.test.ts',
    'src/main/connectors/slackInboxStore.test.ts', 'src/main/apps/statusClassification.test.ts',
    'src/renderer/src/components/SettingsAppsStatusCache.test.ts'
  ]
  const child = spawnSync(process.execPath, [
    '--experimental-transform-types', '--import', './scripts/register-ts.mjs',
    '--import', './src/main/connectors/testNetworkGuard.mjs',
    '--test', '--test-concurrency=1', '--test-timeout=20000', ...files
  ], { cwd: process.cwd(), env, stdio: 'inherit', timeout: 120_000 })
  if (child.error) throw child.error
  process.exitCode = child.status ?? 1
} finally { await rm(root, { recursive: true, force: true }) }
