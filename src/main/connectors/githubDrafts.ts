import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GitHubCommentDraft } from '../../shared/drafts'
import { broadcast } from '../agent/events'
import { getBot } from '../store/bots'
import { writeJsonNow } from '../store/jsonStore'
import { dataRoot } from '../store/paths'
import { getSession } from '../store/sessions'
import { listTasks } from '../store/tasks'
import { validGitHubIssueTarget } from './githubTarget'
import { postGitHubIssueComment, requireGitHubConnection } from './githubOAuth'

type DraftInput = Pick<GitHubCommentDraft, 'owner' | 'repo' | 'issueNumber' | 'body'>
let cached: GitHubCommentDraft[] | undefined
let chain: Promise<unknown> = Promise.resolve()
const file = (): string => join(dataRoot(), 'github-comment-drafts.json')
function serial<T>(work: () => Promise<T>): Promise<T> {
  const result = chain.then(work, work)
  chain = result.catch(() => undefined)
  return result
}

async function load(): Promise<GitHubCommentDraft[]> {
  if (cached) return cached
  let raw: string
  try { raw = await readFile(file(), 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return (cached = [])
    throw new Error('Drafts could not be read.')
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error('Draft storage is damaged; it was not changed.') }
  if (!Array.isArray(parsed) || !parsed.every((d) => d && typeof d.id === 'string' && typeof d.sessionId === 'string' && typeof d.botId === 'string' && typeof d.owner === 'string' && typeof d.repo === 'string' && Number.isSafeInteger(d.issueNumber) && typeof d.body === 'string' && ['draft', 'sending', 'sent', 'uncertain', 'cancelled'].includes(d.status))) throw new Error('Draft storage is invalid; it was not changed.')
  const records = parsed as GitHubCommentDraft[]
  if (records.some((d) => d.status === 'sending' || d.feedbackStatus === 'delivering')) {
    const recovered = records.map((d) => ({ ...d,
      ...(d.status === 'sending' ? { status: 'uncertain' as const, feedbackStatus: 'pending' as const, updatedAt: Date.now() } : {}),
      ...(d.feedbackStatus === 'delivering' ? { feedbackStatus: 'uncertain' as const } : {})
    }))
    await writeJsonNow(file(), recovered)
    return (cached = recovered)
  }
  return (cached = records)
}

async function save(records: GitHubCommentDraft[]): Promise<void> { await writeJsonNow(file(), records); cached = records }

/** The task's private session must deliver its draft to the originating chat. */
export async function createGitHubCommentDraft(sessionId: string, botId: string, input: DraftInput): Promise<GitHubCommentDraft> {
  return serial(async () => {
    const session = getSession(sessionId)
    if (!session || !session.botIds.includes(botId) || !getBot(botId)) throw new Error('This Bot does not belong to this conversation.')
    const task = listTasks().find((item) => item.sessionId === sessionId && item.botId === botId && item.sourceSessionId)
    const source = task?.sourceSessionId ? getSession(task.sourceSessionId) : session
    if (!source || source.archived) throw new Error('The originating conversation is unavailable.')
    const owner = typeof input.owner === 'string' ? input.owner.trim() : ''
    const repo = typeof input.repo === 'string' ? input.repo.trim() : ''
    const body = typeof input.body === 'string' ? input.body.trim() : ''
    if (!validGitHubIssueTarget(owner, repo, input.issueNumber) || !body || body.length > 60000) throw new Error('A valid GitHub owner, repository, issue number and comment are required.')
    const records = await load()
    const existing = records.find((d) => d.sessionId === source.id && d.botId === botId && d.status === 'draft' && d.owner.toLowerCase() === owner.toLowerCase() && d.repo.toLowerCase() === repo.toLowerCase() && d.issueNumber === input.issueNumber && d.body === body)
    if (existing) return existing
    const now = Date.now()
    const draft: GitHubCommentDraft = { id: randomUUID(), sessionId: source.id, botId, receiverBotId: task ? (task.requesterBotId ?? task.botId) : botId, owner, repo, issueNumber: input.issueNumber, body, status: 'draft', createdAt: now, updatedAt: now }
    await save([...records, draft])
    broadcast({ type: 'github-draft-updated', draft })
    return draft
  })
}

export async function listGitHubDrafts(sessionId: string): Promise<GitHubCommentDraft[]> {
  return serial(async () => (await load()).filter((d) => d.sessionId === sessionId).map((d) => ({ ...d })))
}

export async function pendingGitHubFeedback(): Promise<GitHubCommentDraft[]> {
  return serial(async () => (await load()).filter((d) => d.feedbackStatus === 'pending').map((d) => ({ ...d })))
}

export async function setGitHubFeedback(id: string, from: GitHubCommentDraft['feedbackStatus'], to: GitHubCommentDraft['feedbackStatus']): Promise<GitHubCommentDraft | null> {
  return serial(async () => {
    const records = await load(), current = records.find((d) => d.id === id)
    if (!current || current.feedbackStatus !== from) return null
    const next = { ...current, feedbackStatus: to }
    await save(records.map((d) => d.id === id ? next : d))
    broadcast({ type: 'github-draft-updated', draft: next })
    return next
  })
}

async function postComment(draft: GitHubCommentDraft): Promise<string> {
  await requireGitHubConnection()
  return postGitHubIssueComment(draft.owner, draft.repo, draft.issueNumber, draft.body)
}

/** Only a trusted renderer user action calls this; no send tool is exposed to models. */
export async function actOnGitHubDraft(id: string, sessionId: string, action: 'send' | 'cancel'): Promise<GitHubCommentDraft> {
  if (action === 'send') await requireGitHubConnection()
  const started = await serial(async () => {
    const records = await load(), current = records.find((d) => d.id === id && d.sessionId === sessionId)
    if (!current || current.status !== 'draft') throw new Error('This draft is no longer available for this action.')
    const next: GitHubCommentDraft = { ...current, status: action === 'send' ? 'sending' : 'cancelled', ...(action === 'cancel' ? { feedbackStatus: 'pending' as const } : {}), updatedAt: Date.now() }
    await save(records.map((d) => d.id === id ? next : d))
    broadcast({ type: 'github-draft-updated', draft: next })
    return next
  })
  if (action !== 'send') return started
  let result: GitHubCommentDraft
  try { const remoteUrl = await postComment(started); result = { ...started, status: 'sent', feedbackStatus: 'pending', updatedAt: Date.now(), remoteUrl } }
  catch { result = { ...started, status: 'uncertain', feedbackStatus: 'pending', updatedAt: Date.now() } }
  return serial(async () => {
      let next = result
      const finalRecords = (await load()).map((d) => d.id === id ? next : d)
      try { await save(finalRecords) } catch {
        // An external side effect may have happened, but its receipt was not
        // durably recorded. Keep the in-process UI honest and never retry.
        next = { ...started, status: 'uncertain', feedbackStatus: 'uncertain', updatedAt: Date.now() }
        cached = finalRecords.map((d) => d.id === id ? next : d)
      }
      broadcast({ type: 'github-draft-updated', draft: next })
      return next
  })
}
