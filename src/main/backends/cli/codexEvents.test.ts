/**
 * Codex app-server notifications, including a reconnect sequence recorded
 * against `codex app-server` 0.166.0. Retryable `error` notices must not
 * abort a turn that then completes.
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SafeStorage } from 'electron'
import { addVaultItem, setVaultStorageForTests } from '../../store/vault.ts'

import { approvalResponse, describeApproval } from './codexApprovals.ts'
import { CodexItems } from './codexItems.ts'
import { codexPoolKey } from './codexPool.ts'
import { CodexTurnError, codexNotification, isTurnEnd, presentCodexError } from './codexEvents.ts'
import { codexTurnPrompt } from './transcript.ts'

// Diagnostics now pass through the local Vault boundary. A plain Node process
// has no Electron app/userData; every test must explicitly own its data root.
let dataDir: string
const previousDataDir = process.env.OPENBOT_DATA_DIR
before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'blinky-codex-events-'))
  process.env.OPENBOT_DATA_DIR = dataDir
})
after(async () => {
  setVaultStorageForTests(undefined)
  if (previousDataDir === undefined) delete process.env.OPENBOT_DATA_DIR
  else process.env.OPENBOT_DATA_DIR = previousDataDir
  await rm(dataDir, { recursive: true, force: true })
})

const THREAD = 'thread-1'
const TURN = 'turn-1'

/** One reconnect notice from a live 0.166 session. Message is nested. */
function reconnect(attempt: string) {
  return {
    method: 'error',
    params: {
      error: {
        message: `Reconnecting... ${attempt}`,
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
        additionalDetails:
          'stream disconnected before completion: Connection reset by peer (os error 54)'
      },
      willRetry: true,
      threadId: THREAD,
      turnId: TURN
    }
  }
}

const RECORDED_TURN = [
  reconnect('2/5'),
  reconnect('3/5'),
  {
    method: 'warning',
    params: {
      threadId: THREAD,
      message: 'Falling back from WebSockets to HTTPS transport'
    }
  },
  {
    method: 'item/started',
    params: {
      threadId: THREAD,
      turnId: TURN,
      item: { type: 'agentMessage', id: 'msg-1', text: '' }
    }
  },
  {
    method: 'item/completed',
    params: {
      threadId: THREAD,
      turnId: TURN,
      item: { type: 'agentMessage', id: 'msg-1', text: 'ok' }
    }
  },
  {
    method: 'thread/tokenUsage/updated',
    params: {
      threadId: THREAD,
      turnId: TURN,
      tokenUsage: {
        total: {
          totalTokens: 12,
          inputTokens: 8,
          cachedInputTokens: 2,
          outputTokens: 4,
          reasoningOutputTokens: 0
        },
        last: { totalTokens: 12, inputTokens: 8, cachedInputTokens: 0, outputTokens: 4 },
        modelContextWindow: 200000
      }
    }
  },
  {
    method: 'turn/completed',
    params: {
      threadId: THREAD,
      turn: {
        id: TURN,
        status: 'completed',
        error: null,
        items: [{ type: 'agentMessage', id: 'msg-1', text: 'ok' }]
      }
    }
  }
]

function play(notes: { method: string; params: unknown }[]) {
  const items = new CodexItems()
  const chunks: ReturnType<typeof codexNotification> = []
  let failure: unknown = null
  let ended = false
  for (const note of notes) {
    try {
      chunks.push(...codexNotification(note.method, note.params, items))
      if (isTurnEnd(note.method)) ended = true
    } catch (err) {
      failure = err
      break
    }
  }
  return { chunks, failure, ended, items }
}

function textOf(chunks: ReturnType<typeof codexNotification>): string {
  return chunks
    .filter((chunk) => chunk.type === 'text')
    .map((chunk) => (chunk.type === 'text' ? chunk.delta : ''))
    .join('')
}

function reasoningOf(chunks: ReturnType<typeof codexNotification>): string {
  return chunks
    .filter((chunk) => chunk.type === 'reasoning')
    .map((chunk) => (chunk.type === 'reasoning' ? chunk.delta : ''))
    .join('')
}

function noticesOf(chunks: ReturnType<typeof codexNotification>): string {
  return chunks.filter((chunk) => chunk.type === 'notice').map((chunk) => chunk.type === 'notice' ? chunk.message : '').join('\n')
}

describe('codex app-server notifications', () => {
  it('keeps a turn that reconnects and then completes', () => {
    const { chunks, failure, ended } = play(RECORDED_TURN)
    assert.equal(failure, null)
    assert.equal(ended, true)
    assert.equal(textOf(chunks), 'ok')

    const notices = noticesOf(chunks)
    assert.match(notices, /Reconnecting\.\.\. 2\/5/)
    assert.match(notices, /Reconnecting\.\.\. 3\/5/)
    assert.match(notices, /Connection reset by peer \(os error 54\)/)
    assert.match(notices, /Falling back from WebSockets to HTTPS transport/)
    assert.equal(reasoningOf(chunks), '')

    const usage = chunks.find((chunk) => chunk.type === 'usage')
    assert.equal(usage?.type, 'usage')
    if (usage?.type === 'usage') {
      assert.equal(usage.usage.inputTokens, 8)
      assert.equal(usage.usage.outputTokens, 4)
      assert.equal(usage.usage.totalTokens, 12)
      assert.equal(usage.usage.cachedInputTokens, 2)
    }
  })

  it('does not repeat an agentMessage that already streamed as deltas', () => {
    const { chunks, failure } = play([
      {
        method: 'item/agentMessage/delta',
        params: { threadId: THREAD, turnId: TURN, itemId: 'msg-1', delta: 'hel' }
      },
      {
        method: 'item/agentMessage/delta',
        params: { threadId: THREAD, turnId: TURN, itemId: 'msg-1', delta: 'lo' }
      },
      {
        method: 'item/completed',
        params: {
          item: { type: 'agentMessage', id: 'msg-1', text: 'hello' },
          threadId: THREAD,
          turnId: TURN
        }
      },
      {
        method: 'turn/completed',
        params: {
          turn: {
            id: TURN,
            status: 'completed',
            error: null,
            items: [{ type: 'agentMessage', id: 'msg-1', text: 'hello' }]
          }
        }
      }
    ])
    assert.equal(failure, null)
    assert.equal(textOf(chunks), 'hello')
  })

  it('separates consecutive agent messages while retaining their streamed text once', () => {
    const items = new CodexItems()
    const first = codexNotification('item/agentMessage/delta', { itemId: 'first', delta: 'Working' }, items)
    const second = codexNotification('item/agentMessage/delta', { itemId: 'second', delta: 'Done' }, items)
    const tail = codexNotification('item/agentMessage/delta', { itemId: 'second', delta: '.' }, items)
    const repeated = codexNotification('item/completed', { item: { type: 'agentMessage', id: 'second', text: 'Done.' } }, items)
    assert.deepEqual([...first, ...second, ...tail], [
      { type: 'text', delta: 'Working', visible: true },
      { type: 'text', delta: '\n\nDone', visible: true },
      { type: 'text', delta: '.', visible: true }
    ])
    assert.deepEqual(repeated, [])
  })

  it('reports a terminal error with the nested message and additionalDetails', () => {
    const { failure, chunks } = play([
      reconnect('1/5'),
      {
        method: 'error',
        params: {
          error: {
            message: 'stream disconnected before completion',
            additionalDetails: 'Connection reset by peer (os error 54)',
            codexErrorInfo: null,
            misalignment: {
              detailedExplanation: 'The connection closed before the reply finished.'
            }
          },
          willRetry: false,
          threadId: THREAD,
          turnId: TURN
        }
      }
    ])
    assert.ok(failure instanceof CodexTurnError)
    assert.match(failure.message, /stream disconnected before completion/)
    assert.match(failure.message, /Connection reset by peer \(os error 54\)/)
    assert.match(failure.message, /closed before the reply finished/)
    assert.notEqual(failure.message, 'codex reported an error')
    assert.match(noticesOf(chunks), /Reconnecting\.\.\. 1\/5/)
  })

  it('reads a string error from older payloads', () => {
    assert.throws(
      () => codexNotification('error', { message: 'unauthorized' }, new CodexItems()),
      /unauthorized/
    )
    assert.throws(
      () => codexNotification('error', { error: 'rate limited' }, new CodexItems()),
      /rate limited/
    )
    assert.throws(
      () => codexNotification('error', { willRetry: false }, new CodexItems()),
      /codex reported an error/
    )
  })

  it('surfaces turn.error when the turn completes as failed', () => {
    const { failure, ended } = play([
      {
        method: 'turn/completed',
        params: {
          threadId: THREAD,
          turn: {
            id: TURN,
            status: 'failed',
            error: {
              message: 'You have hit your usage limit',
              additionalDetails: 'try again at 5pm',
              codexErrorInfo: null,
              misalignment: null
            },
            items: []
          }
        }
      }
    ])
    assert.equal(ended, false)
    assert.ok(failure instanceof CodexTurnError)
    assert.match(failure.message, /You have hit your usage limit/)
    assert.match(failure.message, /try again at 5pm/)
    assert.equal(isTurnEnd('turn/completed'), true)
    assert.equal(isTurnEnd('error'), false)
  })

  it('ends an interrupted turn without treating it as a model failure', () => {
    const { failure, ended, chunks } = play([
      {
        method: 'item/completed',
        params: { item: { type: 'agentMessage', id: 'msg-1', text: 'partial' } }
      },
      {
        method: 'turn/completed',
        params: {
          turn: {
            id: TURN,
            status: 'interrupted',
            error: { message: 'interrupted by user', additionalDetails: null },
            items: [{ type: 'agentMessage', id: 'msg-1', text: 'partial' }]
          }
        }
      }
    ])
    assert.equal(failure, null)
    assert.equal(ended, true)
    assert.equal(textOf(chunks), 'partial')
  })

  it('ignores Codex 0.166 notifications that are not the reply', () => {
    const ignored: { method: string; params: unknown }[] = [
      {
        method: 'hook/started',
        params: { threadId: THREAD, turnId: TURN, run: { status: 'running', eventName: 'preToolUse' } }
      },
      {
        method: 'hook/completed',
        params: {
          threadId: THREAD,
          turnId: TURN,
          run: { status: 'failed', eventName: 'preToolUse', statusMessage: 'hook exploded' }
        }
      },
      {
        method: 'mcpServer/startupStatus/updated',
        params: {
          threadId: THREAD,
          name: 'filesystem',
          status: 'failed',
          error: 'connection refused',
          failureReason: 'startup'
        }
      },
      { method: 'account/updated', params: { authMode: 'chatgpt', planType: 'plus' } },
      {
        method: 'account/login/completed',
        params: { loginId: 'login-1', success: false, error: 'login failed', onboardingEntrypoint: null }
      },
      { method: 'account/rateLimits/updated', params: { rateLimits: { primary: null } } },
      { method: 'account/gatewayOAuth/changed', params: {} },
      {
        method: 'configWarning',
        params: { summary: 'unknown key', details: 'model_provider', path: '/tmp/config.toml' }
      },
      { method: 'deprecationNotice', params: { summary: 'old method', details: null } },
      {
        method: 'thread/realtime/error',
        params: { error: { message: 'audio died' }, threadId: THREAD }
      },
      { method: 'fuzzyFileSearch/sessionUpdated', params: { error: 'nope' } },
      { method: 'model/rerouted', params: { message: 'switched model' } },
      {
        method: 'guardianWarning',
        params: { threadId: THREAD, message: 'Automatic approval review approved (command)' }
      }
    ]
    const { chunks, failure, ended } = play([
      ...ignored,
      {
        method: 'turn/completed',
        params: { turn: { id: TURN, status: 'completed', error: null, items: [] } }
      }
    ])
    assert.equal(failure, null)
    assert.equal(ended, true)
    assert.equal(chunks.length, 0)
  })

  it('shows a guardian warning without ending the turn', () => {
    const { chunks, failure } = play([
      { method: 'guardianWarning', params: { threadId: THREAD, message: 'This command looks unusual' } },
      { method: 'warning', params: { threadId: null, message: '' } }
    ])
    assert.equal(failure, null)
    assert.match(noticesOf(chunks), /This command looks unusual/)
  })

  it('ignores item types that are not the assistant reply', () => {
    const types = [
      'userMessage',
      'hookPrompt',
      'reasoning',
      'plan',
      'commandExecution',
      'fileChange',
      'mcpToolCall',
      'dynamicToolCall',
      'collabAgentToolCall',
      'subAgentActivity',
      'webSearch',
      'imageView',
      'sleep',
      'imageGeneration',
      'enteredReviewMode',
      'exitedReviewMode',
      'contextCompaction',
      'functionCallOutput',
      'notARealItem'
    ]
    for (const type of types) {
      const { chunks, failure } = play([
        {
          method: 'item/started',
          params: { item: { type, id: 'item-1', text: 'should-not-leak', error: 'boom' } }
        },
        {
          method: 'item/completed',
          params: {
            item: {
              type,
              id: 'item-1',
              text: 'should-not-leak',
              command: 'rm -rf /',
              error: 'boom',
              status: 'failed'
            }
          }
        }
      ])
      assert.equal(failure, null, type)
      assert.equal(textOf(chunks), '', type)
      assert.equal(reasoningOf(chunks), '', type)
    }
  })
})

describe('codex run errors', () => {
  it('shows a turn failure as Codex wrote it and keeps the fallback refusal for transport errors', () => {
    const turn = new CodexTurnError('You have hit your usage limit\ntry again at 5pm')
    assert.equal(presentCodexError(turn), turn)

    const wrapped = presentCodexError(new Error('codex app-server did not answer initialize within 20s'))
    assert.match(wrapped.message, /governed app-server was unavailable/)
    assert.match(wrapped.message, /did not answer initialize/)
    assert.ok(wrapped.cause instanceof Error)
  })
})

describe('codex app-server approvals', () => {
  it('describes a command carried on the 0.166 approval request', () => {
    const request = describeApproval('item/commandExecution/requestApproval', {
      threadId: THREAD,
      turnId: TURN,
      itemId: 'cmd-1',
      command: 'git status',
      cwd: '/work',
      commandActions: [{ type: 'unknown', command: 'git status' }]
    })
    assert.equal(request?.kind, 'shell')
    assert.equal(request?.target, 'git status')
    assert.deepEqual(approvalResponse('item/commandExecution/requestApproval', {}, 'approve'), {
      decision: 'accept'
    })
    assert.deepEqual(approvalResponse('item/commandExecution/requestApproval', {}, 'approve-always'), {
      decision: 'acceptForSession'
    })
    assert.deepEqual(approvalResponse('item/commandExecution/requestApproval', {}, 'reject'), {
      decision: 'decline'
    })
  })

  it('describes a command and a patch announced before the approval request', () => {
    const items = new CodexItems()
    codexNotification(
      'item/started',
      {
        item: {
          type: 'commandExecution',
          id: 'cmd-1',
          command: 'ls src',
          cwd: '/work',
          status: 'inProgress',
          commandActions: []
        }
      },
      items
    )
    codexNotification(
      'item/started',
      {
        item: {
          type: 'fileChange',
          id: 'edit-1',
          status: 'inProgress',
          changes: [{ path: 'src/main.ts', diff: '+export {}\n' }]
        }
      },
      items
    )

    const command = describeApproval(
      'item/commandExecution/requestApproval',
      { threadId: THREAD, turnId: TURN, itemId: 'cmd-1' },
      items
    )
    assert.equal(command?.target, 'ls src')

    const edit = describeApproval(
      'item/fileChange/requestApproval',
      { threadId: THREAD, turnId: TURN, itemId: 'edit-1', reason: 'add an export' },
      items
    )
    assert.equal(edit?.kind, 'edit')
    assert.match(edit?.detail ?? '', /src\/main\.ts/)
    assert.match(edit?.detail ?? '', /\+export \{\}/)
    assert.deepEqual(approvalResponse('item/fileChange/requestApproval', {}, 'reject'), {
      decision: 'decline'
    })
  })

  it('describes a permissions grant and a legacy argv approval', () => {
    const permissions = describeApproval('item/permissions/requestApproval', {
      threadId: THREAD,
      turnId: TURN,
      itemId: 'perm-1',
      reason: null,
      permissions: {
        network: { enabled: true },
        fileSystem: { read: ['/work'], write: null, entries: [{ access: 'write', path: 'src/main.ts' }] }
      }
    })
    assert.equal(permissions?.kind, 'mcp')
    assert.match(permissions?.detail ?? '', /network access/)
    assert.match(permissions?.detail ?? '', /src\/main\.ts/)
    assert.deepEqual(
      approvalResponse(
        'item/permissions/requestApproval',
        { permissions: { network: { enabled: true } } },
        'approve-always'
      ),
      { permissions: { network: { enabled: true } }, scope: 'session' }
    )

    const legacy = describeApproval('execCommandApproval', {
      command: ['git', 'diff'],
      cwd: '/work',
      reason: null
    })
    assert.equal(legacy?.target, 'git diff')
    assert.deepEqual(approvalResponse('execCommandApproval', {}, 'approve'), { decision: 'approved' })
    assert.deepEqual(approvalResponse('applyPatchApproval', {}, 'reject'), {
      decision: { denied: { rejection: 'Rejected in BlinkyBot.' } }
    })
  })

  it('refuses an approval it cannot describe', () => {
    assert.equal(describeApproval('item/tool/call', { tool: 'mystery' }), null)
    assert.equal(describeApproval('item/commandExecution/requestApproval', { itemId: 'missing' }), null)
  })
})

describe('codex warm thread', () => {
  it('sends the full transcript once, then only the new user text', () => {
    const messages = [
      { role: 'system' as const, content: 'Be brief' },
      { role: 'user' as const, content: 'First' },
      { role: 'assistant' as const, content: 'Ack' },
      { role: 'user' as const, content: 'Second' }
    ]
    const cold = codexTurnPrompt(false, messages)
    assert.match(cold, /First/)
    assert.match(cold, /Be brief/)
    assert.match(cold, /Second/)
    assert.equal(codexTurnPrompt(true, messages), 'Second')
  })

  it('keeps the bearer token out of the pool key and still distinguishes grants', () => {
    const secret = 'super-secret-token-value'
    const base = {
      binaryPath: '/usr/local/bin/codex',
      cwd: '/work',
      model: 'default',
      sessionKey: 'sess',
      args: ['-c', 'mcp_servers.openbot={url="http://127.0.0.1:9"}']
    }
    const key = codexPoolKey({ ...base, env: { OPENBOT_MCP_TOKEN_OPENBOT: secret } })
    assert.equal(key.includes(secret), false)
    const rotated = codexPoolKey({ ...base, env: { OPENBOT_MCP_TOKEN_OPENBOT: 'other-token' } })
    assert.notEqual(key, rotated)
    assert.equal(codexPoolKey({ ...base, env: { OPENBOT_MCP_TOKEN_OPENBOT: secret } }), key)
  })
})

it('executor trace keeps tool events separate and redacts known credentials', () => {
  const params = { item: { id: 'tool-1', type: 'commandExecution', command: 'echo ok', status: 'completed', aggregatedOutput: 'api_key=secret123456', headers: { Authorization: 'Basic abcdef' }, token: 'private-value' } }
  assert.deepEqual(codexNotification('item/completed', params, new CodexItems()), [])
  const chunks = codexNotification('item/completed', params, new CodexItems(), true)
  assert.equal(chunks.length, 1)
  const trace = chunks[0]
  assert.equal(trace?.type, 'agent_trace')
  if (trace?.type !== 'agent_trace') throw Error('Missing executor trace')
  assert.equal(trace.entry.kind, 'commandExecution')
  assert.match(trace.entry.detail, /echo ok/)
  assert.doesNotMatch(trace.entry.detail, /secret123456/)
  assert.doesNotMatch(trace.entry.detail, /Basic abcdef|private-value/)
})

describe('Codex native automatic approval review', () => {
  it('does not mistake an approval for an error', () => {
    assert.deepEqual(codexNotification('item/autoApprovalReview/completed', { review: { status: 'approved' }, action: { type: 'command', command: 'touch fixture' } }), [])
  })
  it('stops on denial with the operation and stated reason', () => {
    assert.throws(() => codexNotification('item/autoApprovalReview/completed', { review: { status: 'denied', rationale: 'Not authorized for this action' }, action: { type: 'command', command: 'rm fixture' } }), (error: unknown) => error instanceof CodexTurnError && /拒绝/.test(error.message) && /rm fixture/.test(error.message) && /Not authorized/.test(error.message))
  })
  it('does not silently continue after a timed-out review', () => {
    assert.throws(() => codexNotification('item/autoApprovalReview/completed', { review: { status: 'timedOut' }, action: { type: 'networkAccess', host: 'example.test' } }), /超时/)
  })
})

it('diagnostics preserve safe context with an unlocked Vault and fail closed when unavailable or corrupt', async () => {
  const key = randomBytes(32), secret = 'synthetic-vault-diagnostic-4826'
  const storage = {
    isEncryptionAvailable: () => true,
    encryptString(text: string) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
      const bytes = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), bytes])
    },
    decryptString(bytes: Buffer) {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
      decipher.setAuthTag(bytes.subarray(12, 28))
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')
    }
  } as SafeStorage
  const params = { item: { id: 'vault-tool', type: 'commandExecution', command: 'echo safe', status: 'completed', aggregatedOutput: `output ${secret}; api_key=secret123456` } }
  const traceDetail = () => {
    const chunk = codexNotification('item/completed', params, new CodexItems(), true)[0]
    assert.equal(chunk?.type, 'agent_trace')
    if (chunk?.type !== 'agent_trace') throw Error('Missing executor trace')
    return chunk.entry.detail
  }
  const denied = () => codexNotification('item/autoApprovalReview/completed', {
    review: { status: 'denied', rationale: `Not authorized ${secret}` }, action: { type: 'command', command: 'rm fixture' }
  })
  try {
    setVaultStorageForTests(storage)
    await addVaultItem({ kind: 'login', label: 'Synthetic diagnostic fixture', origin: 'https://example.invalid', values: { password: secret } })
    const detail = traceDetail()
    assert.match(detail, /echo safe/)
    assert.doesNotMatch(detail, new RegExp(`${secret}|secret123456`))
    assert.throws(denied, (error: unknown) => error instanceof CodexTurnError && /拒绝/.test(error.message) && /rm fixture/.test(error.message) && /Not authorized/.test(error.message) && !error.message.includes(secret))
    setVaultStorageForTests(null)
    assert.equal(traceDetail(), '[Content withheld: vault unavailable]')
    assert.throws(denied, (error: unknown) => error instanceof CodexTurnError && /拒绝/.test(error.message) && /本轮已停止/.test(error.message) && !/rm fixture|Not authorized/.test(error.message) && !error.message.includes(secret))
    await writeFile(join(dataDir, 'vault.json'), '{damaged synthetic fixture')
    setVaultStorageForTests(storage)
    assert.equal(traceDetail(), '[Content withheld: vault unavailable]')
    assert.throws(denied, (error: unknown) => error instanceof CodexTurnError && /本轮已停止/.test(error.message) && !error.message.includes(secret))
    assert.equal(await readFile(join(dataDir, 'vault.json'), 'utf8'), '{damaged synthetic fixture')
  } finally {
    setVaultStorageForTests(undefined)
    await rm(join(dataDir, 'vault.json'), { force: true })
  }
})
