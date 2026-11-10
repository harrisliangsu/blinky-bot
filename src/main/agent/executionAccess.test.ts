import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Settings } from '../../shared/types.ts'
import { evaluate } from './approvalPolicy.ts'
import { setExecutionAgent, clearExecutionAgent, fullAccessExecutor, executionApprovalSettings, executorAccessSignal, revokeExecutorAccess } from './executionAgent.ts'
import { codexSafety, codexSandboxPolicy, confirmsFullAccess } from '../backends/cli/codexSafety.ts'
import { codexThreadCall } from '../backends/cli/codexThread.ts'
import { remoteBotCreate, remoteBotPatch, remoteBotCopy } from '../collaboration/botAccess.ts'

const settings = { localExecutionPolicy: 'always-allow', approvalPolicy: 'auto-run', automaticReview: false, allowlist: [], denylist: [], asklist: [], semanticPermissionRules: [{ id: 'bot-rule', version: 1, effect: 'ask', text: 'Ask before writes' }] } as unknown as Settings

test('only an explicitly pinned independent executor separates local permission from Bot semantic review', () => {
  const old = { backendId: 'codex', modelId: 'model' }
  setExecutionAgent('old', old, 'owner'); setExecutionAgent('full', { ...old, accessMode: 'full-access' }, 'owner')
  try {
    assert.equal(fullAccessExecutor('old'), false); assert.equal(fullAccessExecutor('home'), false)
    assert.equal(executionApprovalSettings(settings, 'home', true), settings)
    assert.equal(executionApprovalSettings(settings, 'old', true), settings)
    assert.equal(executionApprovalSettings(settings, 'full', false), settings, 'external/account operations keep their policy')
    const actual = executionApprovalSettings(settings, 'full', true)
    assert.equal(evaluate(actual, 'shell', 'fixture', new Set(), false, false, true).outcome, 'allow')
    assert.equal(settings.automaticReview, false); assert.equal(settings.semanticPermissionRules!.length, 1)
    assert.equal(evaluate({ ...actual, denylist: ['*'] }, 'shell', 'fixture', new Set(), false, false, true).outcome, 'deny')
    assert.equal(evaluate(actual, 'shell', 'fixture', new Set(), true, true, true).outcome, 'ask')
    const disabled = { ...settings, localExecutionPolicy: 'never-allow' as const }
    assert.equal(executionApprovalSettings(disabled, 'full', true), disabled)
    old.modelId = 'changed'; assert.equal(fullAccessExecutor('old'), false)
  } finally { clearExecutionAgent('old'); clearExecutionAgent('full') }
})

test('revoking one owner stops its full-access executor without granting an old task or affecting another owner', () => {
  setExecutionAgent('one', { backendId: 'codex', modelId: 'm', accessMode: 'full-access' }, 'a')
  setExecutionAgent('two', { backendId: 'codex', modelId: 'm', accessMode: 'full-access' }, 'b')
  const signal = executorAccessSignal('one')!
  try { revokeExecutorAccess('a'); assert.equal(signal.aborted, true); assert.equal(fullAccessExecutor('one'), false); assert.equal(fullAccessExecutor('two'), true) }
  finally { clearExecutionAgent('one'); clearExecutionAgent('two') }
})

test('full access has explicit thread and turn parameters; read-only/coordinator constraints and managed refusal prevail', () => {
  const access = { executionAccess: 'full-access' as const, approvalPolicy: 'ask-every-time' }
  const safety = codexSafety(access)
  assert.deepEqual(safety, { approvalPolicy: 'never', sandbox: 'danger-full-access', approvalsReviewer: 'user' })
  assert.deepEqual(codexThreadCall({ cwd: '/synthetic', ...safety }).params, { cwd: '/synthetic', ...safety })
  assert.deepEqual(codexThreadCall({ threadId: 'saved-thread', ...safety }).params, { threadId: 'saved-thread', ...safety })
  assert.deepEqual(codexSandboxPolicy(safety.sandbox), { type: 'dangerFullAccess' })
  assert.equal(confirmsFullAccess({ approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'dangerFullAccess' } }), true)
  assert.equal(confirmsFullAccess({ approvalPolicy: 'never', approvalsReviewer: 'auto_review', sandbox: { type: 'dangerFullAccess' } }), false)
  assert.equal(confirmsFullAccess({ approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite' } }), false)
  assert.equal(codexSafety({ ...access, readOnly: true }).sandbox, 'read-only')
  assert.equal(codexSafety({ ...access, coordinatorOnly: true }).sandbox, 'read-only')
  assert.equal(codexSafety({ approvalPolicy: 'auto-run' }).sandbox, 'workspace-write', 'legacy behavior must not broaden')
})

test('a remote persona form cannot grant or revoke native full access and copies never inherit it', () => {
  const before = { executionAgent: { backendId: 'codex', modelId: 'm' }, tools: [], computerUse: false } as any
  const full = { ...before.executionAgent, accessMode: 'full-access' }
  assert.throws(() => remoteBotCreate({ executionAgent: full }), /on the Mac/)
  assert.throws(() => remoteBotPatch(before, { executionAgent: full }), /on the Mac/)
  assert.throws(() => remoteBotPatch({ ...before, executionAgent: full }, { executionAgent: before.executionAgent }), /on the Mac/)
  assert.deepEqual(remoteBotPatch({ ...before, executionAgent: full }, { executionAgent: full }).executionAgent, full)
  assert.equal((remoteBotCopy({ ...before, executionAgent: full }) as any).executionAgent.accessMode, undefined)
})

test('Bot review edits do not alter independent execution, but host permission revocation still aborts it', async () => {
  const { localOperationSignal, noteLocalPermissionSettings } = await import('../localExecution.ts')
  const operation = localOperationSignal(new AbortController().signal, settings, true)
  try {
    noteLocalPermissionSettings({ ...settings, automaticReview: true, semanticPermissionRules: [] })
    assert.equal(operation.signal.aborted, false)
    noteLocalPermissionSettings({ ...settings, denylist: ['new-denial'] })
    assert.equal(operation.signal.aborted, true)
  } finally { operation.dispose() }
})
