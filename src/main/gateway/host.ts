/**
 * The persistence hooks a gateway tool call gets (`ToolHost`).
 *
 * Without these the tool layer still runs, but `remember` would fall back to a
 * private JSON file the app never reads and `handoff` could not name a bot. The
 * whole point of the gateway is that a CLI's own loop reaches OpenBOT's durable
 * state, so the hooks are wired to the same stores the in-app loop uses — and,
 * where the loop puts a rule in front of a store, to the same rule: memory is
 * screened and a hand-off is capped whichever side the call came from.
 *
 * Tools emit their own `AgentEvent`s; these functions only persist.
 */

import type { Bot } from '../../shared/types'
import { handoff, saveMemoryEntry } from '../agent/sessionActions'
import { listBots } from '../store/bots'
import { setTodos } from '../store/sessions'
import { delegateBackgroundTask, reviewBackgroundTask, manageBackgroundTask } from '../tasks'
import { requestToolClarification } from '../tasks/clarifications'
import { listBotMemory } from '../store/memory'
import { recallMemories } from '../agent/memoryRecall'
import { createGitHubWatch, createScheduledInstruction, createGmailWatch, createWebhookWatch, createOnceInstruction, createFolderWatch } from '../routines/create'
import { createGitHubCommentDraft } from '../connectors/githubDrafts'
import { createGmailDraft } from '../connectors/gmailDrafts'
import { createCalendarDraft } from '../connectors/calendarDrafts'
import { createXDraft } from '../connectors/xDrafts'
import { createSlackDraft } from '../connectors/slackDrafts'
import type { ToolHost } from '../tools/types'

function warn(what: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  console.warn(`[gateway] ${what} failed: ${message}`)
}

export const gatewayHost: ToolHost = {
  manageTask: manageBackgroundTask,
  requestInput: requestToolClarification,
  recallMemory: (botId, query, kind, limit) => recallMemories(listBotMemory(botId), query, { kind, limit }),
  /*
   * Through `sessionActions`, not straight to the store: that is where a candidate
   * is screened and deduped. Writing to the store directly meant a CLI's `remember`
   * — including one repeating text it had read off a web page — was persisted
   * unfiltered and replayed into every later prompt, while the in-app loop screened
   * the identical call. The store still mints the id; the tool's emitted entry is
   * the same text.
   */
  async saveMemory(entry) {
    try {
      return await saveMemoryEntry(entry)
    } catch (err) {
      warn('memory save', err)
      return { entry: null, reason: 'memory could not be saved' }
    }
  },

  setTodos(sessionId, todos): void {
    try {
      setTodos(sessionId, todos)
    } catch (err) {
      warn('todo save', err)
    }
  },

  /*
   * Through `sessionActions.handoff`, never straight to the store: that wrapper
   * is where the roster check and the consecutive-handoff cap live. Calling
   * `setActiveBot` directly skipped both, and on a supervised session this is
   * the only live hand-off route — so a bot acting on injected content could
   * point the chat at ANY bot in the app, including one the user never added to
   * it, as often as it liked.
   *
   * A refusal is thrown rather than warned: the hook returns `void`, so the tool
   * cannot see the answer and would otherwise tell the model it had handed over
   * while the floor had not moved. `defineTool` turns the throw into a failed
   * tool result carrying the reason.
   */
  async handoff(sessionId, fromBotId, toBotId, reason): Promise<void> {
    const result = await handoff(sessionId, fromBotId, toBotId, reason)
    if (!result.ok) throw new Error(result.message)
  },

  delegateTask(sessionId, fromBotId, toBotId, prompt, title, continueTaskId, signal, outputFiles, plan) {
    return delegateBackgroundTask(sessionId, fromBotId, toBotId, prompt, title, continueTaskId, signal, outputFiles, plan)
  },
  reviewTask: reviewBackgroundTask,
  scheduleRoutine: createScheduledInstruction,
  scheduleOnceRoutine: createOnceInstruction,
  watchFolderRoutine: createFolderWatch,
  watchGitHubIssue: createGitHubWatch,
  watchGmail: createGmailWatch,
  watchWebhook: createWebhookWatch,
  createGitHubDraft: createGitHubCommentDraft,
  createGmailDraft,
  createCalendarDraft,
  createXDraft,
  createSlackDraft,

  listBots(): Bot[] {
    try {
      return listBots()
    } catch (err) {
      warn('bot list', err)
      return []
    }
  }
}
