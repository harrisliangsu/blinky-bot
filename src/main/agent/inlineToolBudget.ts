/** The application-owned loop can enforce its own inline tool-round budget. */
export function mustDelegateTool(input: { iteration: number; delegated: boolean; executorConfigured: boolean; delegationEnabled: boolean; tool: string }): boolean {
  if (input.delegated || !input.executorConfigured || !input.delegationEnabled || input.iteration <= 2) return false
  // These coordinate the task or communicate with the user; they are not
  // another unit of local execution work.
  return !['delegate_task', 'manage_task', 'review_task', 'decision_review', 'request_help', 'todo_write', 'remember', 'recall'].includes(input.tool)
}
