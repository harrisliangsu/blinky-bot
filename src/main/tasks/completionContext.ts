/** Task-level evidence across execution attempts; never starts or approves work. */
import { createHash } from 'node:crypto'
import { basename, relative, sep } from 'node:path'
import type { AgentTask, Message } from '../../shared/types'
import { taskReviewObjective } from '../agent/taskContinuation'
import { scrubVaultTranscript } from '../store/vaultPrivacy'
const continuationPrefix = 'Continue the previously delegated task in this same conversation. Previous actions may already have happened; inspect the actual state before repeating any command, file change, or external effect. Remaining work:\n\n'
export const remainingInstruction = (task: AgentTask): string => task.prompt.startsWith(continuationPrefix) ? task.prompt.slice(continuationPrefix.length).trim() : task.prompt.trim()
export function taskLineage(task: AgentTask, tasks: AgentTask[]): AgentTask[] {
  taskReviewObjective(task, tasks) // Validate complete ownership/cycle lineage first.
  const byId = new Map(tasks.map(item => [item.id, item])), chain = [task]
  while (chain[0]!.continuedFromTaskId) chain.unshift(byId.get(chain[0]!.continuedFromTaskId!)!)
  return chain
}
export function completionInputKey(task: AgentTask, messages: Message[], reply?: {id:string;updatedAt:number}): string {
  return createHash('sha256').update(JSON.stringify([task.id, task.result, task.review?.recordedAt,reply?.id,reply?.updatedAt,
    messages.filter(message => message.role === 'user' && !message.internal && !message.uiOnly).map(message => [message.id, message.content])])).digest('hex')
}
export function completionContext(task: AgentTask, tasks: AgentTask[], messages: Message[]): object {
  const chain = taskLineage(task, tasks), root = chain[0]!
  const updates = messages.filter(message => message.role === 'user' && !message.internal && !message.uiOnly)
  const attempts = chain.slice(-8).map(item => ({taskId:item.id,status:item.status,remainingInstruction:scrubVaultTranscript(remainingInstruction(item)).slice(-6000),
    result:scrubVaultTranscript(item.result ?? '').slice(-6000),error:scrubVaultTranscript(item.error ?? ''),review:item.review?{outcome:item.review.outcome,summary:scrubVaultTranscript(item.review.summary),evidence:item.review.evidence.map(scrubVaultTranscript)}:undefined,decisionContext:item.decisionContext}))
  return { originalObjective:scrubVaultTranscript(root.prompt), latestUserUpdates:updates.slice(-12).map(message => ({messageId:message.id,role:'user',text:scrubVaultTranscript(message.content)})),
    earlierUserUpdatesOmitted:Math.max(0,updates.length-12), attempts, earlierAttemptsOmitted:Math.max(0,chain.length-8),
    repeatedResult:chain.length>1 && Boolean(task.result) && task.result===chain.at(-2)!.result,
    meaning:'Source-conversation human context needs semantic relevance to this original goal; it is never an automatic authorization override. Stored message order is authoritative, including backdated timestamps. Execution return is not goal completion. Compare evidence, latest user corrections and existing authorization. Identical prose is only a signal to investigate; changed wording alone is not progress.' }
}
/** Reject only an exact repeated plan + unchanged returned evidence/context.
 * No retry count or elapsed time declares a goal complete or grants permission. */
export function repeatedContinuation(previous: AgentTask, tasks: AgentTask[], prompt: string, context: string): boolean {
  if (!previous.continuedFromTaskId || previous.decisionContext !== context || remainingInstruction(previous) !== prompt.trim()) return false
  const prior = taskLineage(previous,tasks).at(-2)
  return Boolean(prior && previous.result && previous.status===prior.status && previous.result===prior.result)
}

/** App-verified deliverable paths for user-visible completion reports. */
export function deliverableEvidencePaths(task: AgentTask): string[] {
  const paths = [...(task.review?.verifiedFiles ?? []), ...(task.acceptance?.files ?? [])]
    .map((file) => (typeof file?.path === 'string' ? file.path : ''))
    .filter((path) => path && !path.includes('\n'))
  return [...new Set(paths)].slice(0, 12)
}

/** One compact line naming verified deliverables; undefined when nothing was verified. */
export function deliverableEvidenceLine(task: AgentTask): string | undefined {
  const paths = deliverableEvidencePaths(task)
  if (!paths.length) return undefined
  const source = task.workspace?.sourceCwd ?? ''
  const shown = paths.map((path) => {
    if (!path.startsWith('/')) return path
    try {
      const rel = source ? relative(source, path) : ''
      return rel && rel !== '..' && !rel.startsWith('..' + sep) ? rel : basename(path)
    } catch { return basename(path) }
  })
  return '交付物（已在工作区核对）：' + shown.join('、')
}
