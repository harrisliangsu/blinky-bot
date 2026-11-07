/**
 * The sidebar's read model for projects.
 *
 * A summary is a join: identity from the project, outstanding work from its
 * board, and the number of chats filed here from the sessions collection. It
 * lives apart from `projects.ts` to keep that module a store: the only thing
 * it knows about sessions is that deleting a project has to unfile them.
 */

import type { ProjectSummary } from '../../shared/types'
import { openCardCount } from './board'
import { listProjects, type StoredProject } from './projects'
import { listSessions } from './sessions'

/** How many chats are filed in each project, in one pass over the sessions. */
function sessionCounts(): Map<string, number> {
  const counts = new Map<string, number>()
  for (const session of listSessions()) {
    const projectId = session.projectId
    if (projectId) counts.set(projectId, (counts.get(projectId) ?? 0) + 1)
  }
  return counts
}

function summarise(project: StoredProject, sessionCount: number): ProjectSummary {
  const summary: ProjectSummary = {
    id: project.id,
    name: project.name,
    emoji: project.emoji,
    color: project.color,
    tags: [...project.tags],
    botCount: project.botIds.length,
    sessionCount,
    openCards: openCardCount(project.board),
    updatedAt: project.updatedAt
  }
  if (project.archived) summary.archived = true
  return summary
}

/** Most recently updated first, matching `listProjects()`. */
export function projectSummaries(): ProjectSummary[] {
  const counts = sessionCounts()
  return listProjects().map((project) => summarise(project, counts.get(project.id) ?? 0))
}
