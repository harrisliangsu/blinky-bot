/** Agent self-management and collaboration tools. */

import type { Tool } from '../types'
import { delegateTaskTool } from './delegate'
import { handoffTool } from './handoff'
import { rememberTool } from './memory'
import { recallTool } from './recall'
import { todoWriteTool } from './todo'
import { requestHelpTool } from './help'
import { reviewTaskTool } from './review'
import { manageTaskTool } from './task'
import { askUserTool } from './clarify'
import { scheduleRoutineTool } from './routine'
import { scheduleOnceTool } from './scheduleOnce'
import { watchFolderTool } from './watchFolder'
import { githubCommentDraftTool } from './githubDraft'
import { watchGitHubIssueTool } from './githubWatch'
import { googleAccountsTool } from './googleAccounts'

export { handoffTool } from './handoff'
export { delegateTaskTool } from './delegate'
export { reviewTaskTool } from './review'
export { manageTaskTool } from './task'
export { askUserTool } from './clarify'
export { scheduleRoutineTool } from './routine'
export { scheduleOnceTool } from './scheduleOnce'
export { watchFolderTool } from './watchFolder'
export { githubCommentDraftTool } from './githubDraft'
export { watchGitHubIssueTool } from './githubWatch'
export { googleAccountsTool } from './googleAccounts'
export { rememberTool, memoryFilePath } from './memory'
export { recallTool } from './recall'
export { todoWriteTool } from './todo'
export { requestHelpTool, returnHumanControl, cancelHumanHelpForSession } from './help'

export const agentTools: Tool[] = [
  todoWriteTool,
  rememberTool,
  recallTool,
  handoffTool,
  delegateTaskTool,
  reviewTaskTool,
  manageTaskTool,
  askUserTool,
  scheduleRoutineTool,
  scheduleOnceTool,
  watchFolderTool,
  githubCommentDraftTool,
  watchGitHubIssueTool,
  googleAccountsTool,
  requestHelpTool
]
