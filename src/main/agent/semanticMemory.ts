/**
 * Durable semantic memory for long conversations.
 *
 * After a run finishes, a history region large enough to be squeezed by the
 * context budget is summarised once by a read-only side call and cached on
 * disk, keyed by the exact region fingerprint. Later turns reuse the cached
 * summary inside the budget; a cache miss falls back to the extractive
 * summary without calling any model. Generation never runs inside a turn
 * and never blocks or fails a run.
 */

import { join } from 'node:path'
import { dataRoot, safeFileName } from '../store/paths'
import { readJsonState, writeJsonNow } from '../store/jsonStore'
import { onAgentEvent } from './events'
import { sessions } from './sessionGateway'
import { getBot } from '../store/bots'
import { getSettings } from '../settings'
import type { Settings } from '../../shared/types'
import { getBackendInfo } from './backendGateway'
import { runSideCall } from './backendGateway'
import { resolveBotBinding } from '../../shared/botBinding'
import { toProviderMessages } from './history'
import { groupBlocks } from './history'
import { applyBudget, contextWindowOr, type SemanticRegionSummary } from './budget'
import { estimateTokens } from './tokens'
import { emitTelemetry } from '../telemetry'

/** Sessions below this many messages never need a squeezed region. */
const TRIGGER_MESSAGES = 40
/** A region smaller than this is not worth a model call. */
const MIN_OMITTED_MESSAGES = 6

interface StoredSummary {
  version: 1
  hash: string
  summary: string
  updatedAt: number
}

const file = (sessionId: string): string => join(dataRoot(), 'semantic-memory', `${safeFileName(sessionId)}.json`)

export async function loadSemanticMemory(sessionId: string): Promise<SemanticRegionSummary | null> {
  const read = await readJsonState<StoredSummary | null>(file(sessionId), null)
  if (read.status !== 'ok' || !read.value || read.value.version !== 1) return null
  const { hash, summary } = read.value
  if (typeof hash !== 'string' || !hash || typeof summary !== 'string' || !summary.trim()) return null
  return { hash, summary }
}

const inflight = new Set<string>()
let installed = false

/** Fire-and-forget generation after each finished run. */
export function installSemanticMemory(): void {
  if (installed) return
  installed = true
  onAgentEvent((event) => {
    if (event.type !== 'done' || inflight.has(event.sessionId)) return
    inflight.add(event.sessionId)
    void preGenerate(event.sessionId)
      .catch((error) => console.warn('[openbot/semantic-memory] generation unavailable', event.sessionId, error))
      .finally(() => inflight.delete(event.sessionId))
  })
}

async function preGenerate(sessionId: string): Promise<void> {
  const session = await sessions.get(sessionId)
  if (!session || session.archived || (session.messages?.length ?? 0) < TRIGGER_MESSAGES) return
  const bot = getBot(session.activeBotId ?? session.botIds[0])
  if (!bot || bot.archived) return
  const settings = getSettings()
  const binding = resolveBotBinding(bot, settings)
  const info = await getBackendInfo(binding.backendId)
  const modelWindow = info?.models?.find((model) => model.id === binding.modelId)?.contextWindow
  const window = contextWindowOr(modelWindow)

  const history = toProviderMessages(session.messages ?? [], { supportsVision: false })
  const budgeted = applyBudget(groupBlocks(history), estimateTokens(''), window)
  if (!budgeted.omittedHash || !budgeted.omittedText) return
  const omittedCount = budgeted.dropped
  if (omittedCount < MIN_OMITTED_MESSAGES) return

  const cached = await loadSemanticMemory(sessionId)
  if (cached && cached.hash === budgeted.omittedHash) return

  const startedAt = Date.now()
  const summary = await generateSummary(binding.backendId, binding.modelId, budgeted.omittedText, settings)
  emitTelemetry({ kind: 'memory.semantic_summary', sessionId, durationMs: Date.now() - startedAt, outcome: summary && summary.trim() ? 'ok' : 'empty', size: budgeted.omittedText.length })
  if (!summary || !summary.trim()) return
  const record: StoredSummary = { version: 1, hash: budgeted.omittedHash, summary: summary.trim().slice(0, 4000), updatedAt: Date.now() }
  await writeJsonNow(file(sessionId), record)
}

const SUMMARY_PROMPT = 'Summarise this earlier conversation region so a later turn can continue seamlessly. Capture: the user\'s standing goals, decisions made, corrections the user gave, commitments made to the user, and unfinished threads or open questions. Plain language in the conversation\'s own language, under 250 words. This summary replaces the region in later context; do not narrate that you are summarising and do not add anything the region does not contain.'

async function generateSummary(backendId: string, modelId: string, regionText: string, settings: Settings): Promise<string | null> {
  const result = await runSideCall(backendId, {
    model: modelId,
    messages: [
      { role: 'system', content: SUMMARY_PROMPT },
      { role: 'user', content: regionText }
    ],
    readOnly: true,
    disableNativeTools: true,
    supportsVision: false,
    signal: AbortSignal.timeout(120_000)
  }, settings)
  return result?.text?.trim() || null
}
