import type { ChatRequest } from '../types'

export function codexSafety(req: Pick<ChatRequest, 'readOnly' | 'restrictNativeWrites' | 'approvalPolicy' | 'coordinatorOnly'>): {
  approvalPolicy: 'never' | 'untrusted' | 'on-request'
  sandbox: 'read-only' | 'workspace-write'
  approvalsReviewer: 'auto_review' | 'user'
} {
  // Coordinator MCP calls (especially delegate_task) must be allowed to
  // request approval; `never` rejects them before the app can route them.
  if (req.coordinatorOnly) return { approvalPolicy: 'on-request', sandbox: 'read-only', approvalsReviewer: 'user' }
  if (req.readOnly || req.restrictNativeWrites) return { approvalPolicy: 'never', sandbox: 'read-only', approvalsReviewer: 'user' }
  if (req.approvalPolicy === 'auto-run') return { approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'auto_review' }
  return { approvalPolicy: 'untrusted', sandbox: 'read-only', approvalsReviewer: 'user' }
}
