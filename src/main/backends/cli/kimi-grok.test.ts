import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { installHint } from '../detectionTable'
import { BACKENDS } from '../registry'
import { probeVersion } from '../versionProbe'
import { which } from '../which'
import { KNOWN_BACKEND_IDS, defaultSettings } from '../../settingsSchema'
import { grokMapper, kimiMapper } from './events'
import { buildGrokArgs, GROK_SPEC, parseGrokModels } from './grok'
import { AGENT_CLI_SPECS } from './index'
import { buildKimiArgs, KIMI_SPEC } from './kimi'

describe('kimi and grok cli adapters', () => {
  it('reads Grok CLI model rows without interpreting diagnostics as models', () => {
    assert.deepEqual(parseGrokModels('You are not authenticated.\n\nDefault model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5\n  - grok-4.5\n  - bad model\n'), [
      { id: 'grok-4.6', label: 'grok-4.6' }, { id: 'grok-4.5', label: 'grok-4.5' }
    ])
    assert.deepEqual(parseGrokModels('Default model: grok-4.6'), [])
  })
  it('lists both in detection specs, settings, and the backend registry', () => {
    const specs = AGENT_CLI_SPECS.map((spec) => spec.id)
    assert.ok(specs.includes('kimi'))
    assert.ok(specs.includes('grok'))
    assert.ok(specs.includes('claude'))
    assert.ok(specs.includes('codex'))

    assert.equal(defaultSettings().backends.kimi?.command, 'kimi')
    assert.equal(defaultSettings().backends.grok?.command, 'grok')
    assert.ok(KNOWN_BACKEND_IDS.includes('kimi'))
    assert.ok(KNOWN_BACKEND_IDS.includes('grok'))
    assert.ok(KNOWN_BACKEND_IDS.includes('xai'))
    assert.ok(KNOWN_BACKEND_IDS.includes('openrouter'))

    const ids = BACKENDS.map((backend) => backend.id)
    for (const id of ['kimi', 'grok', 'claude', 'codex', 'xai', 'openrouter']) {
      assert.ok(ids.includes(id), id)
    }
    assert.equal(BACKENDS.find((backend) => backend.id === 'kimi')?.kind, 'agent-cli')
    assert.equal(BACKENDS.find((backend) => backend.id === 'grok')?.kind, 'agent-cli')
    assert.equal(BACKENDS.find((backend) => backend.id === 'xai')?.kind, 'cloud-api')
  })

  it('builds a kimi print command and drops an unsafe session id', () => {
    assert.deepEqual(
      buildKimiArgs({
        model: 'kimi-code/kimi-for-coding',
        prompt: 'Say hi',
        extra: ['--skills-dir', '/tmp/skills'],
        sessionId: 'ses_01'
      }),
      [
        '--output-format',
        'stream-json',
        '--session',
        'ses_01',
        '--model',
        'kimi-code/kimi-for-coding',
        '--skills-dir',
        '/tmp/skills',
        '-p',
        'Say hi'
      ]
    )
    const unsafe = buildKimiArgs({ model: 'default', prompt: 'x', extra: [], sessionId: '--yolo' })
    assert.equal(unsafe.includes('--session'), false)
    assert.equal(unsafe.includes('--model'), false)
  })

  it('builds a grok headless command without minting a session id', () => {
    assert.deepEqual(
      buildGrokArgs({
        model: 'default',
        promptFile: '/tmp/prompt.txt',
        cwd: '/work',
        system: 'Be brief',
        extra: [],
        sessionId: 'abc123'
      }),
      [
        '--no-auto-update',
        '--always-approve',
        '--output-format',
        'streaming-json',
        '--cwd',
        '/work',
        '--prompt-file',
        '/tmp/prompt.txt',
        '--rules',
        'Be brief',
        '--resume',
        'abc123'
      ]
    )
  })

  it('maps kimi stream-json and grok streaming-json', () => {
    let kimiSession = ''
    const kimi = kimiMapper((id) => {
      kimiSession = id
    })
    assert.deepEqual(kimi({ role: 'assistant', content: 'Hello' }), [{ type: 'text', delta: 'Hello', visible: true }])
    assert.deepEqual(kimi({ role: 'assistant', content: 'Hello world' }), [{ type: 'text', delta: ' world', visible: true }])
    assert.equal(
      kimi({
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'Read', arguments: '{"path":"a.ts"}' } }]
      })[0]?.type,
      'reasoning'
    )
    kimi({ role: 'meta', type: 'session.resume_hint', session_id: 'ses_9' })
    assert.equal(kimiSession, 'ses_9')
    assert.throws(() => kimi({ type: 'error', message: 'auth' }), /auth/)

    let grokSession = ''
    const grok = grokMapper((id) => {
      grokSession = id
    })
    assert.deepEqual(grok({ type: 'text', data: 'Hi' }), [{ type: 'text', delta: 'Hi', visible: true }])
    assert.deepEqual(grok({ type: 'thought', data: 'Looking' }), [{ type: 'reasoning', delta: 'Looking' }])

    const thinking = kimiMapper()
    assert.deepEqual(thinking({ role: 'assistant', reasoning_content: 'Checking', content: '' }), [
      { type: 'reasoning', delta: 'Checking' }
    ])
    assert.deepEqual(
      thinking({ role: 'assistant', reasoning_content: 'Checking the file', content: 'Hi' }),
      [
        { type: 'reasoning', delta: ' the file' },
        { type: 'text', delta: 'Hi', visible: true }
      ]
    )
    assert.deepEqual(thinking({ type: 'thinking_delta', delta: { type: 'thinking_delta', thinking: 'more' } }), [
      { type: 'reasoning', delta: 'more' }
    ])
    assert.equal(grok({ type: 'tool_call', toolName: 'read_file', rawInput: { path: 'a' } })[0]?.type, 'reasoning')
    const end = grok({ type: 'end', sessionId: 'sess-1', usage: { input_tokens: 3, output_tokens: 4 } })
    assert.equal(grokSession, 'sess-1')
    assert.equal(end.find((chunk) => chunk.type === 'usage')?.type, 'usage')
    assert.throws(() => grok({ type: 'error', message: 'nope' }), /nope/)
  })

  it('names the real install packages', () => {
    assert.match(installHint(KIMI_SPEC.install), /@moonshot-ai\/kimi-code/)
    assert.match(installHint(GROK_SPEC.install), /@xai-official\/grok/)
    assert.deepEqual(KIMI_SPEC.install.versionArgs, ['--version'])
    assert.deepEqual(GROK_SPEC.install.versionArgs, ['version'])
  })

  it('resolves kimi and grok through PATH detection', async () => {
    for (const spec of [KIMI_SPEC, GROK_SPEC]) {
      const bin = await which(spec.defaultBinaryPath)
      assert.ok(bin === null || bin.length > 0, spec.id)
      if (!bin) continue
      const probe = await probeVersion(bin, spec.install.versionArgs ?? ['--version'], 8_000)
      assert.notEqual(probe.outcome, 'missing', `${spec.id} at ${bin}`)
    }
  })
})
