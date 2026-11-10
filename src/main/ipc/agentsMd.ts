import { asId, asString } from './validate'
import { CHANNELS } from './channels'
import { emptyArray, handle } from './handler'
import { createAgentsMd, listAgentsMd, readAgentsMd, writeAgentsMd } from '../agentsMd'
import type { AgentsMdRecord } from '../../shared/agentsMd'

const failed = (error: unknown, fallback: string): string => error instanceof Error && error.message ? error.message : fallback

export function registerAgentsMdIpc(): void {
  handle<AgentsMdRecord[]>(CHANNELS.agentsMdList, () => listAgentsMd(), emptyArray)
  handle<{ ok: boolean; content?: string; error?: string }>(
    CHANNELS.agentsMdRead,
    async ([id]) => ({ ok: true, content: await readAgentsMd(asId(id)) }),
    (_args, error) => ({ ok: false, error: failed(error, 'AGENTS.md could not be read.') })
  )
  handle<{ ok: boolean; file?: AgentsMdRecord; error?: string }>(
    CHANNELS.agentsMdCreate,
    async ([title]) => ({ ok: true, file: await createAgentsMd(typeof title === 'string' ? title : undefined) }),
    (_args, error) => ({ ok: false, error: failed(error, 'AGENTS.md could not be created.') })
  )
  handle<{ ok: boolean; error?: string }>(
    CHANNELS.agentsMdWrite,
    async ([id, content]) => { await writeAgentsMd(asId(id), asString(content, 64 * 1024)); return { ok: true } },
    (_args, error) => ({ ok: false, error: failed(error, 'AGENTS.md could not be saved.') })
  )
}
