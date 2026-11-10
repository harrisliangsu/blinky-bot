import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { connectionTestEnvironment } from '../../connectors/testEnvironment.mjs'

test('native provider configuration remains usable without an OAuth directory; detection retains no secret and does not initialize missing config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-kimi-config-'))
  try {
    const env = await connectionTestEnvironment(root)
    env.KIMI_CODE_HOME = join(root, 'profile')
    await mkdir(env.KIMI_CODE_HOME)
    const config = join(env.KIMI_CODE_HOME, 'config.toml')
    await writeFile(config, 'default_model = "synthetic"\n')
    const binary = join(root, 'fixture.cjs'), trace = join(root, 'calls.jsonl')
    const fake = { providers: { selected: { apiKey: 'synthetic-private-key' } }, models: { synthetic: { provider: 'selected', model: 'synthetic' } } }
    await writeFile(binary, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(trace)},JSON.stringify(process.argv.slice(2))+'\\n');process.stdout.write(${JSON.stringify(JSON.stringify(fake))})`, { mode: 0o700 })
    const script = `import assert from 'node:assert/strict';import {rm} from 'node:fs/promises';import {probeCliAuth} from './src/main/backends/cli/authProbe.ts';const one=await probeCliAuth({id:'kimi'},{},${JSON.stringify(binary)});assert.equal(one.state,'logged-in');assert.equal(one.account,'API key configuration');assert.ok(!JSON.stringify(one).includes('synthetic-private-key'));await rm(${JSON.stringify(config)});const two=await probeCliAuth({id:'kimi'},{},${JSON.stringify(binary)});assert.equal(two.state,'logged-out');process.stdout.write(JSON.stringify({one,two}));`
    const result = JSON.parse(execFileSync(process.execPath, ['--experimental-transform-types', '--import', './scripts/register-ts.mjs', '--input-type=module', '-e', script], { env, cwd: process.cwd(), encoding: 'utf8' }))
    assert.equal(result.one.state, 'logged-in')
    assert.deepEqual((await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse), [['provider', 'list', '--json']])
  } finally { await rm(root, { recursive: true, force: true }) }
})
