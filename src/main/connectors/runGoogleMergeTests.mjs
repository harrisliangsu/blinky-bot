/** Narrow account-aware merge validation. No unrelated connectors or desktop tests. */
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectionTestEnvironment } from './testEnvironment.mjs'

if (process.versions.electron) throw Error('Run the Node CLI; native desktop tests remain suspended.')
if (process.argv.slice(2).some(arg => arg !== '--mixed-only')) throw Error('Only --mixed-only is supported.')
const root = await mkdtemp(join(tmpdir(), 'blinky-google-merge-suite-'))
try {
  const files = ['src/main/connectors/googleMergedRecovery.test.ts']
  if (!process.argv.includes('--mixed-only')) files.push('src/main/connectors/googleAccounts.test.ts', 'src/main/connectors/googleOAuth.test.ts', 'src/main/connectors/googleRead.test.ts')
  const child = spawnSync(process.execPath, ['--experimental-transform-types', '--import', './scripts/register-ts.mjs', '--import', './src/main/connectors/testNetworkGuard.mjs', '--test', '--test-concurrency=1', '--test-timeout=20000', ...files], { cwd: process.cwd(), env: await connectionTestEnvironment(root), stdio: 'inherit', timeout: 90000 })
  if (child.error) throw child.error
  process.exitCode = child.status ?? 1
} finally { await rm(root, { recursive: true, force: true }) }
