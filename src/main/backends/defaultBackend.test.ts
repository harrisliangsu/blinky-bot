/**
 * Default-backend selection and the GUI-safe bin search.
 *
 * Run with `node --experimental-strip-types --test src/main/backends/defaultBackend.test.ts`.
 * These modules stay free of Electron so the check can run in CI without a build.
 */

import assert from 'node:assert/strict'
import { access, chmod, constants, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  backendStartBlock,
  chatStartBlock,
  explainStartupFailure,
  isBackendSetupMessage,
  isMissingExecutableError,
  UNCHECKED_BACKEND_DETAIL
} from '../../shared/backendPrompt.ts'
import { pickDefaultBackend, retargetPlan, type BackendChoice } from './defaultBackend.ts'
import { firstExecutable, guiBinaryDirs, npmGlobalBin, nvmVersionBinDirs } from './guiPath.ts'

const home = '/Users/ada'

function choice(partial: Partial<BackendChoice> & Pick<BackendChoice, 'id'>): BackendChoice {
  return {
    kind: 'agent-cli',
    signedIn: true,
    enabled: true,
    ...partial
  }
}

test('gui binary dirs include Homebrew, ~/.local/bin, and the npm global bin', () => {
  const dirs = guiBinaryDirs({
    home,
    platform: 'darwin',
    env: {},
    npmrc: 'prefix=/Users/ada/.npm-global\n'
  })
  assert.ok(dirs.includes('/opt/homebrew/bin'))
  assert.ok(dirs.includes(join(home, '.local', 'bin')))
  assert.ok(dirs.includes(join(home, '.kimi-code', 'bin')))
  assert.ok(dirs.includes(join(home, '.grok', 'bin')))
  assert.ok(dirs.includes(join(home, '.npm-global', 'bin')))
})

test('npm_config_prefix overrides ~/.npmrc and expands a home-relative prefix', () => {
  assert.equal(
    npmGlobalBin({
      home,
      platform: 'darwin',
      env: { npm_config_prefix: '~/tools' },
      npmrc: 'prefix=/ignored\n'
    }),
    join(home, 'tools', 'bin')
  )
})

test('nvm version directories become bin paths and reject alias names', () => {
  const dirs = nvmVersionBinDirs(home, ['v22.14.0', 'lts', 'system'])
  assert.deepEqual(dirs, [join(home, '.nvm', 'versions', 'node', 'v22.14.0', 'bin')])
  const withNvm = guiBinaryDirs({
    home,
    platform: 'darwin',
    env: {},
    extraDirs: dirs
  })
  assert.ok(withNvm.includes(dirs[0]))
})

test('a bare name is found in a later directory when PATH is empty', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-which-'))
  const bin = join(root, 'codex')
  await writeFile(bin, '#!/bin/sh\nexit 0\n')
  await chmod(bin, 0o755)
  const exists = async (full: string): Promise<boolean> => {
    try {
      await access(full, constants.X_OK)
      return true
    } catch {
      return false
    }
  }
  assert.equal(await firstExecutable('codex', ['/nonexistent', root], exists), bin)
  assert.equal(await firstExecutable('missing', [root], exists), null)
  assert.equal(await firstExecutable('/abs/codex', [root], exists), null)
})

test('Kimi and Grok are chosen ahead of OpenCode and behind Claude Code', () => {
  assert.equal(
    pickDefaultBackend([
      choice({ id: 'opencode' }),
      choice({ id: 'grok' }),
      choice({ id: 'kimi' })
    ]),
    'kimi'
  )
  assert.equal(
    pickDefaultBackend([choice({ id: 'grok' }), choice({ id: 'claude' }), choice({ id: 'opencode' })]),
    'claude'
  )
})

test('signed-in CLIs are preferred in Codex, Claude Code, OpenCode order', () => {
  const picked = pickDefaultBackend([
    choice({ id: 'opencode' }),
    choice({ id: 'claude' }),
    choice({ id: 'codex' }),
    choice({ id: 'pi' })
  ])
  assert.equal(picked, 'codex')
})

test('an installed CLI that is not signed in is skipped', () => {
  const picked = pickDefaultBackend([
    choice({ id: 'codex', signedIn: false }),
    choice({ id: 'claude', signedIn: true }),
    choice({ id: 'opencode', signedIn: false })
  ])
  assert.equal(picked, 'claude')
})

test('a disabled backend is not selected', () => {
  const picked = pickDefaultBackend([
    choice({ id: 'codex', enabled: false }),
    choice({ id: 'opencode', signedIn: true })
  ])
  assert.equal(picked, 'opencode')
})

test('an API key is the fallback when no CLI is signed in', () => {
  const picked = pickDefaultBackend([
    choice({ id: 'codex', signedIn: false }),
    choice({ id: 'claude', signedIn: false }),
    choice({ id: 'anthropic', kind: 'cloud-api', signedIn: true }),
    choice({ id: 'openai', kind: 'cloud-api', signedIn: true })
  ])
  assert.equal(picked, 'anthropic')
})

test('nothing signed in selects nothing', () => {
  assert.equal(
    pickDefaultBackend([
      choice({ id: 'opencode', signedIn: false }),
      choice({ id: 'openai', kind: 'cloud-api', signedIn: false })
    ]),
    null
  )
})

test('a ready default stays, and a factory OpenCode bot still moves when OpenCode is missing', () => {
  const plan = retargetPlan({
    defaultBackendId: 'claude',
    bots: [
      { id: 'assistant', backendId: 'claude' },
      { id: 'coder', backendId: 'opencode' }
    ],
    readyIds: new Set(['codex', 'claude']),
    nextDefault: 'codex'
  })
  assert.equal(plan.defaultBackendId, 'claude')
  assert.deepEqual(plan.bots, [{ id: 'coder', backendId: 'claude' }])
})

test('bots still on an unavailable default move, and a ready custom bot stays', () => {
  const plan = retargetPlan({
    defaultBackendId: 'opencode',
    bots: [
      { id: 'assistant', backendId: 'opencode' },
      { id: 'coder', backendId: 'opencode' },
      { id: 'researcher', backendId: 'claude' }
    ],
    readyIds: new Set(['claude']),
    nextDefault: 'claude'
  })
  assert.equal(plan.defaultBackendId, 'claude')
  assert.deepEqual(plan.bots, [
    { id: 'assistant', backendId: 'claude' },
    { id: 'coder', backendId: 'claude' }
  ])
})

test('factory OpenCode bots move when OpenCode is missing, even if Settings names another missing CLI', () => {
  const plan = retargetPlan({
    defaultBackendId: 'pi',
    bots: [{ id: 'assistant', backendId: 'opencode' }],
    readyIds: new Set(['codex']),
    nextDefault: 'codex'
  })
  assert.equal(plan.defaultBackendId, 'codex')
  assert.deepEqual(plan.bots, [{ id: 'assistant', backendId: 'codex' }])
})

test('a bot pointed at a different missing CLI is left for the chat to explain', () => {
  const plan = retargetPlan({
    defaultBackendId: 'opencode',
    bots: [{ id: 'custom', backendId: 'pi' }],
    readyIds: new Set(['codex']),
    nextDefault: 'codex'
  })
  assert.deepEqual(plan.bots, [])
})

test('when nothing is signed in, stored ids stay put', () => {
  const plan = retargetPlan({
    defaultBackendId: 'opencode',
    bots: [{ id: 'assistant', backendId: 'opencode' }],
    readyIds: new Set(),
    nextDefault: null
  })
  assert.equal(plan.defaultBackendId, 'opencode')
  assert.deepEqual(plan.bots, [])
})

test('a missing backend is explained in chat and links to Settings → Providers', () => {
  const message = backendStartBlock(
    { label: 'OpenCode', status: 'not-installed' },
    [{ status: 'not-installed' }],
    'opencode'
  )
  assert.ok(message)
  assert.equal(isBackendSetupMessage(message), true)
  assert.match(message, /Settings → Providers/)
  assert.equal(message.includes('ENOENT'), false)
  assert.equal(message.includes('spawn'), false)
  assert.match(message, /No signed-in model is available/)
})

test('a missing backend names itself when another backend is already signed in', () => {
  const message = backendStartBlock(
    { label: 'pi', status: 'needs-key' },
    [{ status: 'needs-key' }, { status: 'available' }],
    'pi'
  )
  assert.match(message ?? '', /^pi is not installed or not signed in/)
  assert.equal(isBackendSetupMessage(message ?? ''), true)
})

test('a chat send does not refuse a backend that has not been probed', () => {
  assert.equal(
    chatStartBlock(
      { label: 'Codex', status: 'not-installed', statusDetail: UNCHECKED_BACKEND_DETAIL },
      [{ status: 'not-installed' }],
      'codex'
    ),
    null
  )
  assert.equal(chatStartBlock(null, [], 'codex'), null)
  const blocked = chatStartBlock(
    { label: 'Codex', status: 'needs-key', statusDetail: 'Codex is installed but not signed in.' },
    [{ status: 'available' }],
    'codex'
  )
  assert.match(blocked ?? '', /not signed in/)
})

test('an available backend is allowed to start', () => {
  assert.equal(
    backendStartBlock({ label: 'Codex', status: 'available' }, [{ status: 'available' }], 'codex'),
    null
  )
})

test('spawn ENOENT becomes the setup message and a real CLI failure does not', () => {
  const friendly = backendStartBlock(
    { label: 'OpenCode', status: 'not-installed' },
    [{ status: 'not-installed' }],
    'opencode'
  )
  assert.ok(friendly)
  const raw = 'OpenCode failed to start (spawn opencode ENOENT).'
  assert.equal(isMissingExecutableError(raw), true)
  assert.equal(
    explainStartupFailure(raw, friendly, `Assistant stopped early: ${raw}`),
    friendly
  )
  assert.equal(
    explainStartupFailure('exited with code 1', friendly, 'Assistant stopped early: exited with code 1'),
    'Assistant stopped early: exited with code 1'
  )
})
