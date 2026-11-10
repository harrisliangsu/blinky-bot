/** Semantic hints chosen by the Bot; never execution or authorization policy. */
export interface TaskContext {
  summary: string
  categories: string[]
  scope: string[]
  boundaries: string[]
  /** Scope ownership only. Use depends_on separately for execution ordering. */
  parentTaskId?: string
}

export interface TaskContextInput {
  summary: string
  categories?: string[]
  scope?: string[]
  boundaries?: string[]
  parent_task_id?: string
}

/** Shared by delegation and description updates across all tool transports. */
export const taskContextSchema = {
  type: 'object',
  description: 'A short goal and expected result, free-form categories, work areas/files/project/environment, and exclusions. Keep secrets and raw transcripts out. Categories are hints, never routing rules. Replace the whole description when the user changes scope.',
  properties: {
    summary: { type: 'string', description: 'Current goal and expected deliverable; at most 1200 characters.' },
    categories: { type: 'array', items: { type: 'string' }, description: 'Up to 6 short free-form categories; no fixed taxonomy.' },
    scope: { type: 'array', items: { type: 'string' }, description: 'Up to 12 work areas, paths, project or environment identifiers; at most 300 characters each.' },
    boundaries: { type: 'array', items: { type: 'string' }, description: 'Up to 8 exclusions or integration boundaries; at most 300 characters each. Does not grant authority.' },
    parent_task_id: { type: 'string', description: 'Optional owning overall task from this Bot and source conversation. This is scope ownership, not an execution dependency.' }
  },
  required: ['summary']
}
