/**
 * CLI login reports. Parsers must keep a public label and drop anything
 * that looks like a token.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { cacheableShellEnv, withUserIdentity } from '../loginShellEnv.ts'
import {
  CLI_AUTH_METHODS,
  authMethod,
  commandUnrecognized,
  interpretCliAuth,
  loginTerminalCommand,
  parseClaudeAuthStatus,
  parseCodexLoginStatus,
  parseDroidDoctor,
  parseOpencodeAuthList,
  publicAccountLabel
} from './authStatus.ts'

const absent = { file: false, envNames: [] as string[], rowKey: false }

describe('cli auth status parsers', () => {
  it('reads codex login status without keeping a key', () => {
    assert.deepEqual(parseCodexLoginStatus(1, 'Not logged in\n', ''), { state: 'logged-out' })
    assert.deepEqual(parseCodexLoginStatus(0, 'Logged in using ChatGPT\n', ''), {
      state: 'logged-in',
      account: 'ChatGPT'
    })
    const keyed = parseCodexLoginStatus(0, 'Logged in using an API key (sk-proj-abcdefghijklmnopqrstuvwxyz)\n', '')
    assert.equal(keyed.state, 'logged-in')
    assert.equal(keyed.account, 'API key')
    assert.equal(JSON.stringify(keyed).includes('sk-proj'), false)
    assert.equal(parseCodexLoginStatus(0, '', '').state, 'logged-in')
    assert.equal(parseCodexLoginStatus(2, 'panic: auth store', '').state, 'unknown')
  })

  it('reads claude auth status json and text', () => {
    assert.deepEqual(
      parseClaudeAuthStatus(0, '{"loggedIn":true,"authMethod":"claude.ai","email":"ada@example.com"}\n', ''),
      { state: 'logged-in', account: 'ada@example.com' }
    )
    assert.deepEqual(parseClaudeAuthStatus(1, '{"loggedIn":false,"authMethod":"none"}\n', ''), {
      state: 'logged-out'
    })
    const token = parseClaudeAuthStatus(
      0,
      '{"loggedIn":true,"authMethod":"oauth_token","accessToken":"sk-ant-secretvalue"}\n',
      ''
    )
    assert.equal(token.state, 'logged-in')
    assert.equal(token.account, 'OAuth')
    assert.equal(JSON.stringify(token).includes('sk-ant'), false)
    assert.equal(parseClaudeAuthStatus(1, 'Not logged in\n', '').state, 'logged-out')
  })

  it('reads opencode auth list names and ignores secret values', () => {
    const listed = parseOpencodeAuthList(
      0,
      '{"anthropic":{"type":"oauth","key":"sk-ant-secretvalue"},"openai":{"type":"api"}}\n',
      ''
    )
    assert.equal(listed.state, 'logged-in')
    assert.match(listed.account ?? '', /anthropic/)
    assert.match(listed.account ?? '', /openai/)
    assert.equal(JSON.stringify(listed).includes('sk-ant'), false)
    assert.equal(parseOpencodeAuthList(0, '', '').state, 'logged-out')
    assert.equal(parseOpencodeAuthList(0, 'anthropic\nopenai\n', '').account, 'anthropic, openai')
  })

  it('reads droid doctor auth rows', () => {
    assert.deepEqual(
      parseDroidDoctor(
        0,
        JSON.stringify({
          ok: true,
          results: [{ id: 'auth.verify', category: 'auth', status: 'pass', detail: 'stored login' }]
        }),
        ''
      ),
      { state: 'logged-in' }
    )
    assert.equal(
      parseDroidDoctor(
        0,
        JSON.stringify({
          ok: true,
          results: [{ id: 'auth.verify', category: 'auth', status: 'pass', detail: 'using FACTORY_API_KEY' }]
        }),
        ''
      ).account,
      'FACTORY_API_KEY'
    )
    assert.equal(
      parseDroidDoctor(1, JSON.stringify({ ok: false, results: [{ id: 'auth.verify', status: 'fail' }] }), '').state,
      'logged-out'
    )
  })

  it('falls back to credential presence when a CLI has no status command', () => {
    assert.equal(interpretCliAuth('kimi', null, absent).state, 'logged-out')
    assert.equal(interpretCliAuth('kimi', null, { ...absent, file: true }).state, 'logged-in')
    assert.deepEqual(interpretCliAuth('grok', null, { ...absent, rowKey: true }), {
      state: 'logged-in',
      account: 'API key'
    })
    assert.equal(interpretCliAuth('grok', null, { ...absent, file: true }).account, undefined)
    assert.equal(
      interpretCliAuth('pi', null, { ...absent, envNames: ['ANTHROPIC_API_KEY'] }).account,
      'ANTHROPIC_API_KEY'
    )
    assert.equal(JSON.stringify(interpretCliAuth('pi', null, { ...absent, envNames: ['ANTHROPIC_API_KEY'] })).includes('sk-'), false)
  })

  it('trusts a definitive status command over a leftover file', () => {
    const command = {
      ran: true,
      code: 1,
      stdout: 'Not logged in',
      stderr: '',
      timedOut: false,
      unrecognized: false
    }
    assert.equal(interpretCliAuth('codex', command, { ...absent, file: true }).state, 'logged-out')
    assert.equal(
      interpretCliAuth('codex', { ...command, timedOut: true, code: null, stdout: '' }, { ...absent, file: true }).state,
      'logged-in'
    )
    assert.equal(
      interpretCliAuth(
        'claude',
        { ran: true, code: 2, stdout: '', stderr: 'unknown command auth', timedOut: false, unrecognized: true },
        absent
      ).state,
      'logged-out'
    )
    assert.equal(commandUnrecognized('', 'error: unrecognized subcommand'), true)
  })

  it('documents the official login command for each CLI', () => {
    assert.deepEqual(
      CLI_AUTH_METHODS.map((method) => method.id),
      ['opencode', 'claude', 'codex', 'kimi', 'grok', 'pi', 'droid']
    )
    assert.deepEqual(authMethod('opencode')?.loginArgs, ['auth', 'login'])
    assert.deepEqual(authMethod('claude')?.loginArgs, ['auth', 'login'])
    assert.deepEqual(authMethod('claude')?.statusArgs, ['auth', 'status'])
    assert.deepEqual(authMethod('codex')?.loginArgs, ['login'])
    assert.deepEqual(authMethod('codex')?.statusArgs, ['login', 'status'])
    assert.deepEqual(authMethod('kimi')?.loginArgs, ['login'])
    assert.equal(authMethod('kimi')?.statusArgs, undefined)
    assert.deepEqual(authMethod('grok')?.loginArgs, ['login'])
    assert.deepEqual(authMethod('pi')?.loginArgs, [])
    assert.equal(authMethod('pi')?.slashLogin, true)
    assert.deepEqual(authMethod('droid')?.statusArgs, ['doctor', '--json', '--auth'])
    const line = loginTerminalCommand('/usr/local/bin/codex', ['login'], '/tmp/blinky/codex.exit')
    assert.match(line, /'\/usr\/local\/bin\/codex' 'login'/)
    assert.match(line, /codex\.exit/)
    assert.equal(line.includes('sk-'), false)
    const spaced = loginTerminalCommand("/Users/ada/My CLIs/codex", ['login'], '/tmp/s')
    assert.match(spaced, /'\/Users\/ada\/My CLIs\/codex'/)
  })

  it('drops secret-shaped account labels', () => {
    assert.equal(publicAccountLabel('sk-ant-abcdefghijklmnopqrstuvwxyz'), undefined)
    assert.equal(publicAccountLabel('ada@example.com'), 'ada@example.com')
  })
})

describe('cli child environment', () => {
  it('passes login shell proxy settings to children without caching them', () => {
    const captured = {
      PATH: '/bin', HTTPS_PROXY: 'http://user:secret@proxy:8080',
      http_proxy: 'http://proxy:8080', NO_PROXY: 'localhost', no_proxy: '127.0.0.1'
    }
    const child = withUserIdentity({}, captured)
    assert.equal(child.HTTPS_PROXY, captured.HTTPS_PROXY)
    assert.equal(child.http_proxy, captured.http_proxy)
    assert.equal(child.NO_PROXY, captured.NO_PROXY)
    assert.equal(child.no_proxy, captured.no_proxy)
    assert.deepEqual(cacheableShellEnv(captured), { PATH: '/bin' })
  })
  it('keeps the login shell home and fills HOME when the child env dropped it', () => {
    const filled = withUserIdentity({ HOME: '   ', PATH: '/usr/bin' })
    assert.ok(filled.HOME && filled.HOME.trim().length > 0)
    const captured = withUserIdentity(
      { HOME: '/tmp/wrong', PATH: '/usr/bin', USER: 'ada' },
      {
        HOME: '/Users/ada',
        XDG_CONFIG_HOME: '/Users/ada/.config',
        XDG_DATA_HOME: '/Users/ada/.local/share',
        PATH: '/opt/homebrew/bin'
      }
    )
    assert.equal(captured.HOME, '/Users/ada')
    assert.equal(captured.XDG_CONFIG_HOME, '/Users/ada/.config')
    assert.equal(captured.XDG_DATA_HOME, '/Users/ada/.local/share')
    assert.match(captured.PATH ?? '', /homebrew/)
    assert.match(captured.PATH ?? '', /\/usr\/bin/)
    assert.equal(captured.USER, 'ada')
  })
})
