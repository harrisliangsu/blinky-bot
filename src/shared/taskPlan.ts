/** Independent choices made by the Bot, then constrained by the host. */
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent'
export type TaskWorkspaceMode = 'auto' | 'isolated' | 'shared'
export interface TaskPlanInput {
  priority?: TaskPriority
  priority_reason?: string
  depends_on?: string[]
  workspace?: TaskWorkspaceMode
  workspace_reason?: string
  session_reason?: string
}
export interface TaskPlan {
  priority: TaskPriority
  priorityReason: string
  dependencies: string[]
  workspace: TaskWorkspaceMode
  workspaceReason: string
  sourceCwd: string
  sessionReason: string
}
export interface TaskWorkspace {
  strategy: 'git-worktree' | 'directory' | 'shared' | 'legacy'
  path: string
  sourceCwd: string
  manifest: string
  repoRoot?: string
  branch?: string
  basedOnTaskId?: string
  baseline?: { head: string; trackedPatchSha256: string; untrackedCount: number }
  createdAt: number
}
export interface TaskSessionChoice { mode: 'new' | 'continue'; reason: string; previousTaskId?: string }
