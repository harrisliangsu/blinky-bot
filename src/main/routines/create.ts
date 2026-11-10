import type { Routine } from '../../shared/types'
import { broadcast } from '../ipc/broadcast'
import { getBot } from '../store/bots'
import { createRoutineDurable } from '../store/routines'
import { getSession } from '../store/sessions'
import { isValidCron, isValidScheduleOptions, type ScheduleOptions } from './cron'
import { validGitHubIssueTarget } from '../connectors/githubTarget'
import { readGoogleCredentials } from '../connectors/googleSecrets'
import { getSettings } from '../settings'
import { requestApproval } from '../agent/approval'
import { deniedRuleForCall } from '../agent/approvalPolicy'
import { signalFor } from '../agent/cancel'
import { expandHome, resolvePath } from '../tools/paths'
import { isAbsolute, resolve } from 'node:path'
import { assertFolderObservationAllowed, canonicalFolder, folderMetadataFingerprint } from './folderWatch'

export type RoutineNotification = NonNullable<Routine['notifyPolicy']>
function notifyPolicy(value?: RoutineNotification): RoutineNotification {
  if (value !== undefined && !['always', 'on_change', 'quiet'].includes(value)) throw new TypeError('通知策略无效。')
  return value ?? 'always'
}
function context(sessionId: string, botId: string, name: string, instruction: string): { session: NonNullable<ReturnType<typeof getSession>>; title: string; body: string } {
  const session = getSession(sessionId), bot = getBot(botId)
  if (!session || session.archived || !session.botIds.includes(botId) || session.mode !== 'agent' || !bot || bot.archived) throw new TypeError('This Bot cannot create a routine in the current conversation.')
  const title = name.trim().slice(0, 200), body = instruction.trim().slice(0, 20_000)
  if (!title || !body) throw new TypeError('A name and instruction are required.')
  return { session, title, body }
}

/** Reuses the ordinary read approval path; the physical root is saved once. */
export async function authorizeFolderObservation(sessionId: string, botId: string, path: string): Promise<string> {
  const { session } = context(sessionId, botId, 'folder', 'observe metadata')
  if (getBot(botId)?.computerTarget?.kind && getBot(botId)?.computerTarget?.kind !== 'local') throw new Error('本机文件夹例程需要使用“我的电脑”的 Bot。')
  const settings = getSettings(), raw = expandHome(path.trim(), session.cwd)
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(session.cwd, raw)
  assertFolderObservationAllowed(absolute, settings)
  if (deniedRuleForCall(settings, { id: 'folder-creation', name: 'watch_folder', args: { path: absolute } })) throw new Error('文件夹观察被当前限制拒绝。')
  const canonical = await canonicalFolder(absolute)
  if (deniedRuleForCall(settings, { id: 'folder-creation', name: 'watch_folder', args: { path: canonical } })) throw new Error('文件夹物理路径被当前限制拒绝。')
  const signal = signalFor(sessionId) ?? new AbortController().signal
  await resolvePath({ sessionId, botId, cwd: session.cwd, settings, signal, emit: () => {}, requestApproval: async request => {
    const result = await requestApproval({ sessionId, toolName: request.toolName, target: canonical, kind: request.kind,
      summary: request.summary, detail: request.detail ?? '', signal, force: request.force, requestId: request.id })
    return result.approved
  } }, canonical, { tool: 'watch_folder', mode: 'read' })
  if (signal.aborted) throw new Error('文件夹观察创建已停止。')
  return canonical
}

/** Store a scheduled instruction before telling the model it exists. */
export async function createScheduledInstruction(sessionId: string, botId: string, name: string, instruction: string, cron: string, options: ScheduleOptions & { notifyPolicy?: RoutineNotification } = {}): Promise<Routine> {
  const { title, body } = context(sessionId, botId, name, instruction), schedule = cron.trim()
  if (!isValidCron(schedule) || !isValidScheduleOptions(options)) throw new TypeError('A valid cron expression, timezone and non-negative minute windows are required.')
  const { notifyPolicy: policy, ...timing } = options
  const routine = await createRoutineDurable({ botId, name: title, instruction: body, trigger: { kind: 'schedule', cron: schedule, ...timing }, notifyPolicy: notifyPolicy(policy), replayMode: 'adaptive' })
  broadcast({ type: 'routine-updated', routine })
  return routine
}

export async function createOnceInstruction(sessionId: string, botId: string, name: string, instruction: string, at: number, lateMinutes = 0, policy?: RoutineNotification): Promise<Routine> {
  const { title, body } = context(sessionId, botId, name, instruction)
  if (!Number.isSafeInteger(at) || at < 0 || !isValidScheduleOptions({ lateMinutes })) throw new TypeError('一次性任务需要有效的时间点和延后分钟数。')
  const routine = await createRoutineDurable({ botId, name: title, instruction: body, trigger: { kind: 'once', at, ...(lateMinutes ? { lateMinutes } : {}) }, replayMode: 'adaptive', notifyPolicy: notifyPolicy(policy) })
  broadcast({ type: 'routine-updated', routine })
  return routine
}

export async function createFolderWatch(sessionId: string, botId: string, name: string, instruction: string, path: string, policy?: RoutineNotification): Promise<Routine> {
  const { title, body } = context(sessionId, botId, name, instruction)
  const notification = notifyPolicy(policy)
  const canonical = await authorizeFolderObservation(sessionId, botId, path)
  const baseline = await folderMetadataFingerprint(canonical, { settings: getSettings() })
  context(sessionId, botId, name, instruction)
  const routine = await createRoutineDurable({ botId, name: title, instruction: body, trigger: { kind: 'folder_change', path: canonical }, watchCursor: baseline, watchCheckedAt: Date.now(), replayMode: 'adaptive', notifyPolicy: notification })
  broadcast({ type: 'routine-updated', routine })
  return routine
}

export async function createGitHubWatch(sessionId: string, botId: string, name: string, instruction: string, ownerInput: string, repoInput: string, issueNumber: number): Promise<Routine> {
  const session = getSession(sessionId), owner = ownerInput.trim(), repo = repoInput.trim()
  if (!session || session.archived || !session.botIds.includes(botId) || session.mode !== 'agent' || !getBot(botId)) throw new TypeError('This Bot cannot create a routine in the current conversation.')
  const title = name.trim().slice(0, 200), body = instruction.trim().slice(0, 20_000)
  if (!title || !body || !validGitHubIssueTarget(owner, repo, issueNumber)) throw new TypeError('A name, instruction and valid GitHub issue or pull request are required.')
  const routine = await createRoutineDurable({ botId, name: title, instruction: body, trigger: { kind: 'github_issue', owner, repo, issueNumber }, replayMode: 'adaptive' })
  broadcast({ type: 'routine-updated', routine })
  return routine
}

export async function createGmailWatch(sessionId: string, botId: string, name: string, instruction: string, query: string, accountId?: string): Promise<Routine> {
  const session = getSession(sessionId)
  if (!session || session.archived || !session.botIds.includes(botId) || session.mode !== 'agent' || !getBot(botId)) throw new TypeError('This Bot cannot create a routine in the current conversation.')
  const title = name.trim().slice(0, 200), body = instruction.trim().slice(0, 20_000), clean = query.trim()
  if (!title || !body || clean.length > 512) throw new TypeError('A name, instruction and valid Gmail query are required.')
  const account = await readGoogleCredentials('gmail', accountId)
  if (!account) throw new Error('Gmail is not connected.')
  const routine = await createRoutineDurable({ botId, name: title, instruction: body, trigger: { kind: 'gmail_query', query: clean, account: account.account, ...(accountId ? { accountId } : {}) }, replayMode: 'adaptive' })
  broadcast({ type: 'routine-updated', routine })
  return routine
}

/** A webhook is only a signal: its untrusted body is never sent to the Bot. */
export async function createWebhookWatch(sessionId: string, botId: string, name: string, instruction: string): Promise<Routine> {
  const session = getSession(sessionId)
  if (!session || session.archived || !session.botIds.includes(botId) || session.mode !== 'agent' || !getBot(botId)) throw new TypeError('This Bot cannot create a routine in the current conversation.')
  const title = name.trim().slice(0, 200), body = instruction.trim().slice(0, 20_000)
  if (!title || !body) throw new TypeError('A name and instruction are required.')
  const routine = await createRoutineDurable({ botId, name: title, instruction: body, trigger: { kind: 'webhook' }, replayMode: 'adaptive' })
  broadcast({ type: 'routine-updated', routine })
  return routine
}
