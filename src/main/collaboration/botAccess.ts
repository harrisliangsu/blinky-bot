import type { Bot } from '../../shared/types'
import { RoomAccessError } from './access'

/** Workspace control permits managing personas, never minting local grants. */
export function remoteBotCreate(input: Record<string, unknown>): Record<string, unknown> {
  if (input.tools !== undefined && (!Array.isArray(input.tools) || input.tools.length > 0) || input.computerUse !== undefined && input.computerUse !== false) {
    throw new RoomAccessError(403, 'Allow this Bot’s tools and computer access on the Mac.')
  }
  return { ...input, tools: [], computerUse: false, computerTarget: { kind: 'local' } }
}

export function remoteBotPatch(before: Bot, patch: Record<string, unknown>): Record<string, unknown> {
  const result = { ...patch }
  for (const field of ['tools', 'computerUse'] as const) {
    if (!Object.hasOwn(result, field)) continue
    if (JSON.stringify(result[field]) !== JSON.stringify(before[field])) throw new RoomAccessError(403, 'Change this Bot’s tool and computer permissions on the Mac.')
    // An unchanged stale form must not overwrite a host permission edit.
    delete result[field]
  }
  return result
}

/** A copy is a new principal; app/tool grants cannot spread to it by copying. */
export function remoteBotCopy(source: Bot): Record<string, unknown> {
  return remoteBotCreate({ ...source, name: `${source.name} copy`, tools: [], computerUse: false, computerTarget: { kind: 'local' }, archived: false, pinned: false })
}
