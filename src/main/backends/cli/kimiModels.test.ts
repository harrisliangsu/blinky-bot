import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseKimiModels } from './kimiModels.ts'
import { buildKimiArgs, kimiBackend } from './kimi.ts'
import { runtimeModels } from '../../../shared/botRuntime.ts'

const example = {
  providers: { private: { api_key: 'secret-for-test-only' } },
  models: {
    'kimi-code/k3': { provider: 'managed:kimi-code', model: 'k3', maxContextSize: 262144, capabilities: ['image_in', 'tool_use'] },
    'Custom Provider/custom-model': { provider: 'Custom Provider', model: 'custom-model', capabilities: [] },
    ' broken\nmodel': { provider: 'p', model: 'm' },
    'missing-provider': { model: 'm' },
    'bad-row': null
  }
}

test('Kimi configured model aliases become safe picker rows without provider credentials', () => {
  const models = parseKimiModels(JSON.stringify(example))
  assert.deepEqual(models.map((row) => row.id), ['kimi-code/k3', 'Custom Provider/custom-model'])
  assert.equal(models[0]?.contextWindow, 262144)
  assert.equal(models[0]?.supportsTools, true)
  assert.equal(models[0]?.supportsVision, true)
  assert.equal(models[1]?.supportsVision, false)
  assert.ok(!JSON.stringify(models).includes('secret-for-test-only'))
  assert.deepEqual(parseKimiModels('invalid'), [])
  assert.deepEqual(parseKimiModels(JSON.stringify({ models: [] })), [])
})

test('Kimi effort choices come from each model rather than a universal fallback', () => {
  const models = parseKimiModels(JSON.stringify({ models: {
    efforts: { provider: 'kimi', model: 'new', capabilities: ['thinking'], supportEfforts: ['low', 'high', 'max', 'unknown'] },
    legacy: { provider: 'kimi', model: 'legacy', capabilities: ['thinking', 'always_thinking'] },
    plain: { provider: 'kimi', model: 'plain', capabilities: [] }
  } }))
  assert.deepEqual(models.map(model => model.supportedThinking), [['low', 'high', 'max'], [], []])
})

test('Kimi model discovery and invocation use the configured CLI and exact alias', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'blinky-kimi-models-'))
  const binary = join(dir, 'fake-kimi')
  try {
    await writeFile(binary, `#!/usr/bin/env node\nif (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['provider', 'list', '--json'])) process.exit(2);\nconsole.log(${JSON.stringify(JSON.stringify(example))});\n`)
    await chmod(binary, 0o700)
    const models = await kimiBackend.listModels({ enabled: true, command: binary })
    assert.deepEqual(models.map((row) => row.id), ['default', 'kimi-code/k3', 'Custom Provider/custom-model'])
    const picker = runtimeModels('kimi', models, 'Custom Provider/custom-model')
    assert.deepEqual(picker.map((row) => row.id), models.map((row) => row.id))
    const args = buildKimiArgs({ model: models[2]!.id, prompt: 'hello', extra: [] })
    assert.deepEqual(args.slice(0, 4), ['--output-format', 'stream-json', '--model', 'Custom Provider/custom-model'])
    const unavailable = await kimiBackend.listModels({ enabled: true, command: join(dir, 'not-installed') })
    assert.deepEqual(unavailable.map((row) => row.id), ['default'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
