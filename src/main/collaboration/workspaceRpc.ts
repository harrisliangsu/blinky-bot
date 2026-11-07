/** An authenticated alternate transport over existing application business handlers. */
import type { Message, Session } from '../../shared/types'
import { remoteChannelPolicies } from '../../shared/remoteCapabilities'
import { roomAccess, RoomAccessError } from './access'
import { roomRealtime } from './realtime'
import { roomHistory } from './history'
import { publicRemoteData, publicRemoteMessage, preserveRedactedPatch } from './publicData'
import { invokeRemoteBusinessHandler } from './businessRegistry'
import { getSession, getSessionAttachmentData } from '../store/sessions'
import { liveMessages } from '../agent/liveMessages'
import { getMessageQueue } from '../store/messageQueue'
import { getBot } from '../store/bots'
import { getRoutine } from '../store/routines'
import { saveVoiceLanguage } from '../settings'
import { asId } from '../ipc/validate'
import { enqueueRoomTurn } from './runtime'
import { safeLine } from '../agent/untrusted'
import { defangSpeakerLabels } from '../agent/history'
import { listTaskClarifications, answerTaskClarification, cancelTaskClarification, protectedQuestion } from '../tasks/clarifications'
import type { AgentTaskClarification } from '../../shared/activity'
import { saveUserMemory, deleteUserMemory } from '../ipc/memory'
import { publishDesktopEvent } from '../ipc/eventBus'
import { uploadRemoteFile, remoteAttachments } from './uploads'
import { searchAll } from '../search'
import type { ActivityItem, CollaborationRoom } from '../../shared/types'
import { asString } from '../ipc/validate'
import { listVaultItems } from '../store/vault'
import { listGmailDrafts } from '../connectors/gmailDrafts'
import { listSlackDrafts } from '../connectors/slackDrafts'
import { listXDrafts } from '../connectors/xDrafts'
import { listCalendarDrafts } from '../connectors/calendarDrafts'
import { listGitHubDrafts } from '../connectors/githubDrafts'
import { listSendRules } from '../connectors/sendRules'
import { remoteBotCopy, remoteBotCreate, remoteBotPatch } from './botAccess'
import { getTask } from '../store/tasks'
import { taskVisibleInRoom } from './taskAccess'

export type RemoteAccess = ReturnType<typeof roomAccess.authorize>
export interface RemoteContext { id: string; grant: string; touched: number; slots: { chat: string | null; agent: string | null } }
const contexts = new Map<string, RemoteContext>()
export function remoteContext(access: RemoteAccess, id: unknown): RemoteContext {
  if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw new RoomAccessError(400, 'Invalid browser connection.')
  for (const [key, context] of contexts) if (Date.now() - context.touched > 30 * 60_000) contexts.delete(key)
  const key = access.grant + ':' + id
  let context = contexts.get(key)
  if (!context) { if (contexts.size >= 256) throw new RoomAccessError(429, 'Too many browser connections.'); context = { id, grant: access.grant, touched: Date.now(), slots: { chat: null, agent: null } }; contexts.set(key, context) }
  context.touched = Date.now(); return context
}
export function clearRemoteContexts(): void { contexts.clear() }
export function remoteSession(access: RemoteAccess, id: unknown): Session {
  const sessionId = asId(id)
  if (access.scope !== 'workspace' && sessionId !== access.room.sessionId) throw new RoomAccessError(403, 'This device is approved only for its room.')
  const session = getSession(sessionId)
  if (!session) throw new RoomAccessError(404, 'The conversation is unavailable.')
  return session
}
export function remoteSessionPage(access: RemoteAccess, id: unknown, before?: unknown, knownVersion?: unknown) {
  const session = remoteSession(access, id), source = roomRealtime.snapshot(session.id, session.messages, liveMessages(session.id))
  const query = new URLSearchParams()
  if (before !== undefined) { if (typeof before !== 'string') throw new RoomAccessError(400, 'Invalid history cursor.'); query.set('before', before) }
  const page = roomHistory(source, { id: access.room.id + ':' + session.id, sessionId: session.id, token: access.room.token }, query)
  const ids = new Set(page.messages.map(message => message.id))
  const messages = source.filter(message => ids.has(message.id)).map(publicRemoteMessage).filter((message): message is Message => !!message)
  roomRealtime.markPublic(session.id, messages.map(message => message.id), source)
  return { ...(typeof knownVersion === 'number' && Number.isSafeInteger(knownVersion) ? { changes: remoteMessageChanges(session, knownVersion) } : {}), value: publicRemoteData({ ...session, messages }), page: { sessionId: session.id, ...page.history, revision: roomRealtime.revision(session.id) } }
}
export function remoteMessageChanges(session: Session, since: number) {
  const changed = roomRealtime.changes(session.id, since), live = liveMessages(session.id)
  const upserts: Array<{ message: Message; move: boolean }> = [], removed: string[] = []
  for (const item of changed.changes) {
    const saved = session.messages.find(message => message.id === item.id), streaming = live.find(message => message.id === item.id)
    const message = saved && !saved.streaming ? saved : streaming ?? saved
    const projected = message ? publicRemoteMessage(message) : null
    if (projected) { upserts.push({ message: projected, move: item.move }); roomRealtime.markPublic(session.id, [projected.id], message ? [message] : []) }
    else if (item.wasPublic) removed.push(item.id)
  }
  return { revision: changed.revision, reset: changed.reset, upserts, removed }
}
const ordinary = (request: AgentTaskClarification): boolean => request.questions.every(question => !protectedQuestion(question) && ['fact', 'preference', 'implementation'].includes(question.kind ?? ''))
const allowedSettings = new Set(['theme', 'language', 'vibrant', 'uiScale', 'accent', 'sendShortcut', 'linkOpen', 'expandSteps', 'defaultBackendId', 'defaultModelId', 'defaultThinking', 'defaultMode'])
function plain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RoomAccessError(400, 'Expected form fields.')
  return value as Record<string, unknown>
}
function safeInput(value: unknown, depth = 0): void {
  if (depth > 40) throw new RoomAccessError(400, 'The request is too deeply nested.')
  if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new RoomAccessError(400, 'Invalid form fields.')
    safeInput(item, depth + 1)
  }
}

export async function remoteRpc(access: RemoteAccess, context: RemoteContext, input: Record<string, unknown>, allowed: () => boolean) {
  const channel = input.channel, args = input.args
  if (typeof channel !== 'string' || !Array.isArray(args) || args.length > 20) throw new RoomAccessError(400, 'Invalid application request.')
  // JSON arrays turn optional undefined arguments into null. Restore only
  // explicit, bounded positions so the desktop handler sees its own contract.
  if (input.undefinedArgs !== undefined) {
    if (!Array.isArray(input.undefinedArgs) || input.undefinedArgs.length > args.length || input.undefinedArgs.some(index => !Number.isInteger(index) || index < 0 || index >= args.length || args[index] !== null)) throw new RoomAccessError(400, 'Invalid optional arguments.')
    for (const index of input.undefinedArgs) args[index] = undefined
  }
  safeInput(args)
  const history = channel === 'openbot:remote:history', watch = channel === 'openbot:sessions:watch'
  const policy = history || watch ? 'read' : remoteChannelPolicies.get(channel)
  if (!policy) throw new RoomAccessError(403, 'This operation needs confirmation or a native capability on the Mac.')
  if (policy === 'write' && access.permission !== 'control') throw new RoomAccessError(403, 'This device has view-only access.')
  if (!allowed()) throw new RoomAccessError(401, 'This device is no longer approved.')
  if (channel === 'openbot:remote:upload') return { value: await uploadRemoteFile(access.grant, args[0], allowed) }
  if (watch) {
    if (args[0] !== 'chat' && args[0] !== 'agent') throw new RoomAccessError(400, 'Invalid conversation slot.')
    context.slots[args[0] as 'chat' | 'agent'] = args[1] === null ? null : remoteSession(access, args[1]).id
    return { value: null }
  }
  if (channel === 'openbot:sessions:get' || history) return remoteSessionPage(access, args[0], history ? args[1] : undefined, history ? undefined : input.knownVersion)
  if (channel === 'openbot:sessions:attachment') {
    const session = remoteSession(access, args[0]), message = session.messages.find(item => item.id === args[1])
    if (!message || !publicRemoteMessage(message) || !message.attachments?.some(item => item.id === args[2])) throw new RoomAccessError(404, 'This attachment is unavailable.')
    return { value: getSessionAttachmentData(session.id, asId(args[1]), asId(args[2])) }
  }
  if (access.scope !== 'workspace' && ['openbot:tasks:list', 'openbot:tasks:summaries', 'openbot:tasks:get', 'openbot:tasks:cancel', 'openbot:tasks:create'].includes(channel)) {
    if (channel === 'openbot:tasks:create') throw new RoomAccessError(403, 'Creating workspace tasks requires workspace approval on the Mac.')
    if (channel === 'openbot:tasks:list' || channel === 'openbot:tasks:summaries') {
      const value = await invokeRemoteBusinessHandler(channel, args)
      if (!Array.isArray(value)) return { value: publicRemoteData(value) }
      return { value: publicRemoteData(value.filter(item => item && typeof item.id === 'string' && taskVisibleInRoom(getTask(item.id), access.room.sessionId))) }
    }
    if (!taskVisibleInRoom(getTask(asId(args[0])), access.room.sessionId)) throw new RoomAccessError(403, 'This task belongs to another conversation.')
  }
  if (access.scope !== 'workspace' && !channel.startsWith('openbot:agent:') && !channel.startsWith('openbot:tasks:')) throw new RoomAccessError(403, 'Workspace access has not been approved for this device.')
  if (channel.startsWith('openbot:agent:')) remoteSession(access, args[0])
  if (channel === 'openbot:agent:liveMessages') return { value: publicRemoteData(liveMessages(asId(args[0]))) }
  if (channel === 'openbot:sessions:react') {
    const session = remoteSession(access, args[0]), message = session.messages.find(item => item.id === args[1])
    if (!message || !publicRemoteMessage(message)) throw new RoomAccessError(404, 'This public message is unavailable.')
    args[3] = (access.deviceName.slice(0, 55) + ' · device ' + access.deviceId.slice(-6)).slice(0, 80)
  }
  if (channel === 'openbot:agent:send' || channel === 'openbot:agent:enqueue') {
    const session = remoteSession(access, args[0]), text = safeLine(typeof args[1] === 'string' ? args[1] : '', 10_000), requestId = input.requestId
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,120}$/.test(requestId)) throw new RoomAccessError(400, 'A stable message receipt is required.')
    const attachments = remoteAttachments(access.grant, args[2])
    if (!text && !attachments.length) throw new RoomAccessError(400, 'A message is required.')
    const names = session.botIds.map(id => getBot(id)?.name ?? '').filter(Boolean)
    const line = '[remote device] ' + defangSpeakerLabels(access.deviceName + ': ' + text, names)
    const receipt = await enqueueRoomTurn(session.id, access.room.token + ':' + access.deviceId, requestId, line, allowed, attachments)
    return { value: channel.endsWith(':send') ? true : publicRemoteData(getMessageQueue(session.id)), receipt }
  }
  if (channel === 'openbot:tasks:clarifications') {
    const requests = await listTaskClarifications(typeof args[0] === 'string' ? args[0] : undefined)
    return { value: publicRemoteData(requests.filter(request => ordinary(request) && (access.scope === 'workspace' || request.sourceSessionId === access.room.sessionId || request.executionSessionId === access.room.sessionId))) }
  }
  if (channel === 'openbot:tasks:answerClarification' || channel === 'openbot:tasks:cancelClarification') {
    const request = (await listTaskClarifications()).find(item => item.id === args[0])
    if (!request || !ordinary(request)) throw new RoomAccessError(403, 'Authorization and secret questions must be handled on the Mac.')
    if (access.scope !== 'workspace' && request.sourceSessionId !== access.room.sessionId && request.executionSessionId !== access.room.sessionId) throw new RoomAccessError(403, 'This question belongs to another conversation.')
    if (!allowed()) throw new RoomAccessError(401, 'This device is no longer approved.')
    const value = channel.endsWith(':answerClarification') ? await answerTaskClarification(request.id, args[1]) : await cancelTaskClarification(request.id)
    return { value: publicRemoteData({ ok: true, request: value }) }
  }
  if (channel === 'openbot:voice:language') return { value: { ok: true, language: await saveVoiceLanguage(args[0]) } }
  if (channel === 'openbot:search:query') return { value: publicRemoteData(searchAll(asString(args[0], 500), typeof args[1] === 'number' ? args[1] : 50, args[2] === true, publicRemoteMessage, value => publicRemoteData({ value }).value)) }
  if (channel === 'openbot:activity:list') {
    const items = await invokeRemoteBusinessHandler(channel, args) as ActivityItem[]
    return { value: publicRemoteData(items.filter(item => item.kind !== 'approval' && item.kind !== 'help')) }
  }
  if (channel === 'openbot:rooms:list' && access.permission === 'view') {
    const rooms = await invokeRemoteBusinessHandler(channel, args) as CollaborationRoom[]
    return { value: publicRemoteData(rooms.map(room => ({ ...room, inviteUrl: '' }))) }
  }
  if (channel === 'openbot:bots:addMemory' || channel === 'openbot:bots:removeMemory') {
    const value = channel.endsWith(':addMemory') ? await saveUserMemory(args[0], args[1]) : await deleteUserMemory(args[0], args[1])
    publishDesktopEvent({ type: 'workspace-updated', area: 'bots' })
    return { value: publicRemoteData(value) }
  }
  if (channel === 'openbot:bots:create' && plain(args[0]).computerTarget !== undefined) {
    const target = plain(plain(args[0]).computerTarget)
    if (target.kind !== 'local' || Object.keys(target).some(key => key !== 'kind')) throw new RoomAccessError(403, 'Computer target setup requires the Mac.')
  }
  if (channel === 'openbot:bots:create') args[0] = remoteBotCreate(plain(args[0]))
  if (channel === 'openbot:bots:duplicate') {
    const source = getBot(asId(args[0]))
    if (!source) throw new RoomAccessError(404, 'The Bot is unavailable.')
    return { value: publicRemoteData(await invokeRemoteBusinessHandler('openbot:bots:create', [remoteBotCopy(source)])) }
  }
  if (channel === 'openbot:vault:list') return { value: { ok: true, value: publicRemoteData(await listVaultItems()) } }
  const draftLists = new Map<string, (id: string) => Promise<unknown>>([
    ['openbot:gmail-drafts:list', listGmailDrafts], ['openbot:slack-drafts:list', listSlackDrafts], ['openbot:x-drafts:list', listXDrafts], ['openbot:calendar-drafts:list', listCalendarDrafts], ['openbot:github-drafts:list', listGitHubDrafts]
  ])
  if (draftLists.has(channel)) { const session = remoteSession(access, args[0]); return { value: { ok: true, drafts: publicRemoteData(await draftLists.get(channel)!(session.id)) } } }
  if (channel === 'openbot:send-rules:list') return { value: { ok: true, rules: publicRemoteData(await listSendRules()) } }
  if (channel === 'openbot:settings:update') {
    const patch = plain(args[0])
    if (Object.keys(patch).some(key => !allowedSettings.has(key))) throw new RoomAccessError(403, 'Permission, credential and operating-system settings must be changed on the Mac.')
  }
  if (channel === 'openbot:bots:update') {
    const before = getBot(asId(args[0]))
    if (!before) throw new RoomAccessError(404, 'The Bot is unavailable.')
    const patch = remoteBotPatch(before, preserveRedactedPatch(before as unknown as Record<string, unknown>, plain(args[1])))
    if ('computerTarget' in patch) {
      if (JSON.stringify(patch.computerTarget) !== JSON.stringify(publicRemoteData(before.computerTarget))) throw new RoomAccessError(403, 'Computer target credentials and setup must be changed on the Mac.')
      delete patch.computerTarget
    }
    args[1] = patch
  }
  if (channel === 'openbot:routines:update') {
    const before = getRoutine(asId(args[0]))
    if (before) {
      const patch = preserveRedactedPatch(before as unknown as Record<string, unknown>, plain(args[1]))
      if ('trigger' in patch && JSON.stringify(patch.trigger) === JSON.stringify(publicRemoteData(before.trigger))) delete patch.trigger
      args[1] = patch
    }
  }
  if (!allowed()) throw new RoomAccessError(401, 'This device is no longer approved.')
  return { value: publicRemoteData(await invokeRemoteBusinessHandler(channel, args)) }
}
