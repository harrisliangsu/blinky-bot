import type { ChatRequest } from '../types'

export function codexSandboxPolicy(sandbox: ReturnType<typeof codexSafety>['sandbox']): Record<string, unknown> {
  if (sandbox === 'danger-full-access') return { type: 'dangerFullAccess' }
  return sandbox === 'workspace-write'
    ? { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
    : { type: 'readOnly', networkAccess: false }
}
/** Never silently accept a managed downgrade as a successful full-access run. */
export function confirmsFullAccess(started: { approvalPolicy?: unknown; approvalsReviewer?: unknown; sandbox?: unknown }): boolean {
  return started.approvalPolicy === 'never' && started.approvalsReviewer === 'user' && !!started.sandbox && typeof started.sandbox === 'object' && 'type' in started.sandbox && started.sandbox.type === 'dangerFullAccess'
}

export function codexSafety(req: Pick<ChatRequest, 'readOnly' | 'restrictNativeWrites' | 'approvalPolicy' | 'coordinatorOnly' | 'executionAccess'>): {
  approvalPolicy: 'never' | 'untrusted' | 'on-request'
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'
  approvalsReviewer: 'auto_review' | 'user'
} {
  // Coordinator MCP calls (especially delegate_task) must be allowed to
  // request approval; `never` rejects them before the app can route them.
  if (req.coordinatorOnly) return { approvalPolicy: 'on-request', sandbox: 'read-only', approvalsReviewer: 'user' }
  if (req.readOnly || req.restrictNativeWrites) return { approvalPolicy: 'never', sandbox: 'read-only', approvalsReviewer: 'user' }
  if (req.executionAccess === 'full-access') return { approvalPolicy: 'never', sandbox: 'danger-full-access', approvalsReviewer: 'user' }
  if (req.approvalPolicy === 'auto-run') return { approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'auto_review' }
  return { approvalPolicy: 'untrusted', sandbox: 'read-only', approvalsReviewer: 'user' }
}
