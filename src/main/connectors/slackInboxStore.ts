/** Durable deduplication for Socket Mode events, before acknowledging Slack. */
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { dataRoot, ensureDir } from '../store/paths'
import { writeJsonNow } from '../store/jsonStore'
import type { SlackCredentials } from './slackSecrets'

export interface SlackInbound { id: string; botId: string; teamId: string; userId: string; channelId: string; ts: string; text: string; status: 'pending' | 'queued'; sessionId?: string }
const inflight = new Map<string, { item: SlackInbound; work: Promise<SlackInbound | null> }>()
const dir = (): string => ensureDir(join(dataRoot(), 'slack-inbox'))
const pathFor = (id: string): string => join(dir(), `${id}.json`)
function valid(raw: unknown): raw is SlackInbound {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const v = raw as Record<string, unknown>
  return typeof v.id === 'string' && /^slack-[a-f0-9]{64}$/.test(v.id) && typeof v.botId === 'string' && !!v.botId && typeof v.teamId === 'string' && /^T[A-Z0-9]{2,30}$/.test(v.teamId) && typeof v.userId === 'string' && /^[UW][A-Z0-9]{2,30}$/.test(v.userId) && typeof v.channelId === 'string' && /^[CGD][A-Z0-9]{2,30}$/.test(v.channelId) && typeof v.ts === 'string' && /^\d+\.\d+$/.test(v.ts) && typeof v.text === 'string' && !!v.text && v.text.length <= 20_000 && (v.status === 'pending' || v.status === 'queued') && (v.sessionId === undefined || typeof v.sessionId === 'string')
}
async function read(id: string): Promise<SlackInbound | null> {
  let raw:string;try{raw=await readFile(pathFor(id),'utf8')}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw new Error('Slack inbox cannot be read.')}
  let value:unknown;try{value=JSON.parse(raw)}catch{throw new Error('Slack inbox entry is damaged; it was not changed.')}
  if(!valid(value)||value.id!==id)throw new Error('Slack inbox entry is invalid; it was not changed.')
  return value
}

/** Reject untrusted users, other workspaces, bot messages and edits. */
export function parseSlackEvent(credentials: SlackCredentials, payload: unknown): SlackInbound | null {
  if (credentials.oauth) return null // Browser user grants never enable an inbound receiver.
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const body = payload as Record<string, unknown>, rawEvent = body.event
  if (body.type !== 'event_callback' || body.team_id !== credentials.teamId || typeof body.event_id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(body.event_id) || !rawEvent || typeof rawEvent !== 'object' || Array.isArray(rawEvent)) return null
  const event = rawEvent as Record<string, unknown>
  if (!['message','app_mention'].includes(String(event.type)) || event.subtype !== undefined || event.bot_id !== undefined || event.user !== credentials.allowedUserId || event.user === credentials.botUserId || event.channel !== credentials.channelId || typeof event.ts !== 'string' || !/^\d+\.\d+$/.test(event.ts) || typeof event.text !== 'string' || !event.text.trim() || event.text.length > 20_000) return null
  const id = 'slack-' + createHash('sha256').update(`${credentials.teamId}\0${body.event_id}`).digest('hex')
  return { id, botId: credentials.botId, teamId: credentials.teamId, userId: credentials.allowedUserId, channelId: credentials.channelId, ts: event.ts, text: event.text, status: 'pending' }
}

export async function acceptSlackEvent(credentials: SlackCredentials, payload: unknown): Promise<SlackInbound | null> {
  const item = parseSlackEvent(credentials, payload); if (!item) return null
  const same = (previous: SlackInbound): boolean => previous.teamId === item.teamId && previous.channelId === item.channelId && previous.userId === item.userId && previous.botId === item.botId && previous.text === item.text && previous.ts === item.ts
  const existing = inflight.get(item.id)
  if (existing) {
    if (!same(existing.item)) throw new Error('Slack event id conflicts with a saved event.')
    return existing.work
  }
  const work = (async () => {
    const previous = await read(item.id)
    if (previous) {
      if (!same(previous)) throw new Error('Slack event id conflicts with a saved event.')
      return previous
    }
    await writeJsonNow(pathFor(item.id), item)
    return item
  })().finally(() => inflight.delete(item.id))
  inflight.set(item.id, { item, work }); return work
}

export async function pendingSlackEvents(): Promise<SlackInbound[]> {
  const names = await readdir(dir())
  const values: SlackInbound[] = []
  for (const name of names) {
    if (!/^slack-[a-f0-9]{64}\.json$/.test(name)) continue
    const item = await read(name.slice(0, -5))
    if (item?.status === 'pending') values.push(item)
  }
  return values.sort((a,b) => Number(a.ts) - Number(b.ts))
}
export async function markSlackQueued(id: string, sessionId: string): Promise<void> {
  const item = await read(id); if (!item || item.status === 'queued') return
  await writeJsonNow(pathFor(id), { ...item, status:'queued', sessionId } satisfies SlackInbound)
}
