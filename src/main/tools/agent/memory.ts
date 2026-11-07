/**
 * `remember` — write a durable memory entry for the bot.
 *
 * The host normally persists through `ctx.host.saveMemory`. When it does not,
 * entries land in a JSON file under the tool data directory, which the host
 * supplies as `ctx.dataDir` (the app's userData path). Nothing is hardcoded:
 * the fallback root is derived from the current user's home directory.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { MemoryEntry, ToolSchema } from '../../../shared/types'
import { optStrArray, reqStr } from '../args'
import { requireApproval } from '../approval'
import { safeEmit } from '../events'
import { ToolError } from '../errors'
import { defineTool } from '../results'
import type { ToolContext } from '../types'

const NAME = 'remember'
const MAX_TEXT_CHARS = 2000
const MAX_ENTRIES_PER_BOT = 500

export const schema: ToolSchema = {
  name: NAME,
  description:
    'Save something worth remembering across sessions: a user preference, a project convention, a ' +
    'decision and why it was made. Write one self-contained fact per call, phrased so it still makes ' +
    'sense months later. Do not store secrets, credentials or anything the user asked you to forget.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The fact to remember, in one or two sentences.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional labels. Use profile for durable preferences or facts; use journal for dated historical notes, including the date in the text.' }
    },
    required: ['text']
  },
  mutating: true
}

export const rememberTool = defineTool(schema, async (args, ctx) => {
  const text = reqStr(args, 'text', NAME).trim().slice(0, MAX_TEXT_CHARS)
  if (text.length < 3) throw new ToolError('The memory text is too short to be useful.')
  const tags = optStrArray(args, 'tags')?.slice(0, 10)

  // Always through the gate. The policy decides whether to prompt — reading it
  // here instead skipped the gate outright under `ask-first-time`, and `remember`
  // is self-approving, so nothing upstream would have asked either.
  await requireApproval(ctx, {
    toolName: NAME,
    kind: 'write',
    summary: 'Save a memory for this bot',
    detail: `${text}${tags && tags.length > 0 ? `\n\nTags: ${tags.join(', ')}` : ''}`
  })

  const entry: MemoryEntry = {
    id: randomUUID(),
    botId: ctx.botId,
    text,
    source: 'run',
    ...(tags && tags.length > 0 ? { tags } : {}),
    createdAt: Date.now()
  }

  /*
   * Only the path that actually stored something announces it.
   *
   * `saveMemory` reaches `rememberFact`, which writes through `memoryStore.add`
   * — that mints its OWN id — and broadcasts the stored entry itself. Emitting
   * here as well put a second row in the panel with the same text and a
   * different id, so id-deduping could not collapse them, and the phantom's id
   * existed nowhere on disk: "Forget this entry" on it did nothing at all.
   *
   * `rememberFact` also refuses a duplicate or a screened-out fact, and this
   * emit fired regardless — so a fact the store had just declined to keep still
   * appeared in the panel, and stayed there until the next reload.
   *
   * The fallback path has no such broadcast, so it keeps its own.
   */
  if (ctx.host?.saveMemory) {
    const outcome = await ctx.host.saveMemory(entry)
    if (!outcome.entry) return { callId: ctx.callId ?? '', name: NAME, ok: outcome.reason === 'already remembered', output: outcome.reason }
    return { callId: ctx.callId ?? '', name: NAME, ok: true, output: `Remembered: ${outcome.entry.text}`, detail: { entry: outcome.entry } }
  } else {
    await appendToFallbackStore(ctx, entry)
    safeEmit(ctx, { type: 'memory-updated', botId: ctx.botId, entry })
  }

  return {
    callId: ctx.callId ?? '',
    name: NAME,
    ok: true,
    output: `Remembered: ${text}`,
    detail: { entry }
  }
})

/** `<dataDir>/bot-memory/<botId>.json`, created on demand. */
export function memoryFilePath(ctx: ToolContext): string {
  const root = ctx.dataDir ?? join(homedir(), '.openbot')
  const safeId = ctx.botId.replace(/[^a-zA-Z0-9._-]/g, '_') || 'default'
  return join(root, 'bot-memory', `${safeId}.json`)
}

async function appendToFallbackStore(ctx: ToolContext, entry: MemoryEntry): Promise<void> {
  const file = memoryFilePath(ctx)
  await mkdir(join(file, '..'), { recursive: true })
  const existing = await readEntries(file)
  existing.push(entry)
  const trimmed = existing.slice(-MAX_ENTRIES_PER_BOT)
  await writeFile(file, `${JSON.stringify(trimmed, null, 2)}\n`, 'utf8')
}

async function readEntries(file: string): Promise<MemoryEntry[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    return Array.isArray(parsed) ? (parsed as MemoryEntry[]) : []
  } catch {
    return []
  }
}
