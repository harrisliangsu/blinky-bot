import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getComputerProvider, resetComputerProviders } from '../index'
import { withComputerApproval } from '../gate'
import type { ComputerProvider, ComputerTarget } from '../../../../shared/types'
import type { ToolContext } from '../../types'

test('open_app with a redirected browser page does not return the unallowed screenshot', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'blinky-navigation-gate-'))
  const target: ComputerTarget = { kind: 'browser', botId: 'navigation-gate-fixture', provider: 'ego' }
  const provider = getComputerProvider(target, { sessionId: 'test', dataDir }) as ComputerProvider & { activeApp: () => Promise<string | undefined> }
  let host = 'allowed.example'
  let screenshots = 0
  provider.activeApp = async () => host
  provider.screenshot = async () => { screenshots++; return { image: 'test-frame', width: 100, height: 100, scale: 1 } }
  const events: unknown[] = []
  const ctx = {
    sessionId: 'test', botId: 'navigation-gate-fixture', computerTarget: target, dataDir,
    signal: new AbortController().signal,
    settings: { computerUseAllowedApps: ['Allowed', 'allowed.example'] },
    requestApproval: async () => true,
    emit: (event: unknown) => events.push(event)
  } as unknown as ToolContext
  try {
    await assert.rejects(withComputerApproval(ctx, {
      toolName: 'open_app', summary: 'open', detail: 'open', targetApp: 'Allowed'
    }, async () => { host = 'other.example' }), /not in the computer-use allowlist/)
    assert.equal(screenshots, 1, 'only the approval preview may be captured')
    assert.equal(events.length, 0, 'the redirected page must not be emitted to the model')
  } finally {
    resetComputerProviders()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('a delayed redirect during settling cannot return an unallowed screenshot', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'blinky-navigation-gate-'))
  const target: ComputerTarget = { kind: 'browser', botId: 'delayed-gate-fixture', provider: 'ego' }
  const provider = getComputerProvider(target, { sessionId: 'test', dataDir }) as ComputerProvider & { activeApp: () => Promise<string | undefined> }
  let host = 'allowed.example'
  let screenshots = 0
  provider.activeApp = async () => host
  provider.screenshot = async () => { screenshots++; return { image: 'test-frame', width: 100, height: 100, scale: 1 } }
  const events: unknown[] = []
  const ctx = { sessionId: 'test', botId: target.botId, computerTarget: target, dataDir, signal: new AbortController().signal,
    settings: { computerUseAllowedApps: ['allowed.example'] }, requestApproval: async () => true,
    emit: (event: unknown) => events.push(event) } as unknown as ToolContext
  try {
    await assert.rejects(withComputerApproval(ctx, {
      toolName: 'navigate', summary: 'open', detail: 'open', targetApp: 'allowed.example', settleMs: 40
    }, async () => { setTimeout(() => { host = 'other.example' }, 5) }), /not in the computer-use allowlist/)
    assert.equal(screenshots, 1)
    assert.equal(events.length, 0)
  } finally { resetComputerProviders(); await rm(dataDir, { recursive: true, force: true }) }
})

test('navigation from an unallowed or unknown current page asks without a preview', async () => {
  for (const initial of ['other.example', undefined]) {
    const dataDir = await mkdtemp(join(tmpdir(), 'blinky-navigation-gate-'))
    const target: ComputerTarget = { kind: 'browser', botId: 'preview-gate-fixture', provider: 'ego' }
    const provider = getComputerProvider(target, { sessionId: 'test', dataDir }) as ComputerProvider & { activeApp: () => Promise<string | undefined> }
    let host = initial
    let screenshots = 0
    let approval: { preview?: string } | undefined
    provider.activeApp = async () => host
    provider.screenshot = async () => { screenshots++; return { image: 'test-frame', width: 100, height: 100, scale: 1 } }
    const ctx = { sessionId: 'test', botId: target.botId, computerTarget: target, dataDir, signal: new AbortController().signal,
      settings: { computerUseAllowedApps: ['allowed.example'] },
      requestApproval: async (request: { preview?: string }) => { approval = request; return true }, emit: () => {} } as unknown as ToolContext
    try {
      await withComputerApproval(ctx, {
        toolName: 'navigate', summary: 'open', detail: 'open', targetApp: 'allowed.example'
      }, async () => { host = 'allowed.example' })
      assert.equal(approval?.preview, undefined)
      assert.equal(screenshots, 1, 'only the allowed result page is captured')
    } finally { resetComputerProviders(); await rm(dataDir, { recursive: true, force: true }) }
  }
})

test('reused previews are not emitted after an unallowed navigation', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'blinky-navigation-gate-'))
  const target: ComputerTarget = { kind: 'browser', botId: 'reuse-gate-fixture', provider: 'ego' }
  const provider = getComputerProvider(target, { sessionId: 'test', dataDir }) as ComputerProvider & { activeApp: () => Promise<string | undefined> }
  let host = 'allowed.example'
  provider.activeApp = async () => host
  provider.screenshot = async () => ({ image: 'test-frame', width: 100, height: 100, scale: 1 })
  const events: unknown[] = []
  const ctx = { sessionId: 'test', botId: target.botId, computerTarget: target, dataDir, signal: new AbortController().signal,
    settings: { computerUseAllowedApps: ['allowed.example'] }, requestApproval: async () => true,
    emit: (event: unknown) => events.push(event) } as unknown as ToolContext
  try {
    await assert.rejects(withComputerApproval(ctx, {
      toolName: 'screenshot', summary: 'see', detail: 'see', reusePreviewAsResult: true
    }, async () => { host = 'other.example' }), /not in the computer-use allowlist/)
    assert.equal(events.length, 0)
  } finally { resetComputerProviders(); await rm(dataDir, { recursive: true, force: true }) }
})

test('a page changing during preview capture is omitted from the approval', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'blinky-navigation-gate-'))
  const target: ComputerTarget = { kind: 'browser', botId: 'capture-gate-fixture', provider: 'ego' }
  const provider = getComputerProvider(target, { sessionId: 'test', dataDir }) as ComputerProvider & { activeApp: () => Promise<string | undefined> }
  let host = 'allowed.example'
  let captureCount = 0
  let approval: { preview?: string } | undefined
  provider.activeApp = async () => host
  provider.screenshot = async () => {
    if (++captureCount === 1) host = 'other.example'
    return { image: 'test-frame', width: 100, height: 100, scale: 1 }
  }
  const ctx = { sessionId: 'test', botId: target.botId, computerTarget: target, dataDir, signal: new AbortController().signal,
    settings: { computerUseAllowedApps: ['allowed.example'] },
    requestApproval: async (request: { preview?: string }) => { approval = request; return true }, emit: () => {} } as unknown as ToolContext
  try {
    await withComputerApproval(ctx, { toolName: 'navigate', summary: 'open', detail: 'open', targetApp: 'allowed.example' },
      async () => { host = 'allowed.example' })
    assert.equal(approval?.preview, undefined)
    assert.equal(captureCount, 2)
  } finally { resetComputerProviders(); await rm(dataDir, { recursive: true, force: true }) }
})

test('a redirect while the user considers approval prevents click and input', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'blinky-navigation-gate-'))
  const target: ComputerTarget = { kind: 'browser', botId: 'approval-wait-fixture', provider: 'ego' }
  const provider = getComputerProvider(target, { sessionId: 'test', dataDir }) as ComputerProvider & { activeApp: () => Promise<string | undefined> }
  let host = 'allowed.example', actions = 0
  provider.activeApp = async () => host
  provider.screenshot = async () => ({ image: 'test-frame', width: 100, height: 100, scale: 1 })
  const ctx = { sessionId: 'test', botId: target.botId, computerTarget: target, dataDir, signal: new AbortController().signal,
    settings: { computerUseAllowedApps: ['allowed.example'] }, requestApproval: async () => { host = 'other.example'; return true }, emit: () => {} } as unknown as ToolContext
  try {
    await assert.rejects(withComputerApproval(ctx, { toolName: 'click', summary: 'click', detail: 'click' }, async () => { actions++ }), /not in the computer-use allowlist/)
    assert.equal(actions, 0)
  } finally { resetComputerProviders(); await rm(dataDir, { recursive: true, force: true }) }
})
