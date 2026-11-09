/**
 * Context-window budgeting.
 *
 * The system prompt and the most recent turns are never dropped. When history does not
 * fit, the middle is replaced by a compact summary — the opening request stays
 * (it holds the goal) and the tail stays (it holds the state). A cached
 * semantic summary of the omitted region is used when its fingerprint
 * matches; otherwise the region is condensed extractively. Neither path
 * calls a model inside the turn.
 */

import { createHash } from 'node:crypto'
import type { ProviderMessage } from './contracts'
import { textOf } from './contracts'
import type { HistoryBlock } from './history'
import { estimateMessageTokens, estimateMessagesTokens, estimateTokens, fitToTokens } from './tokens'
import { oneLine } from './text'

/** A cached model-written summary of the omitted history region. */
export interface SemanticRegionSummary {
  /** Fingerprint of the exact region this summary replaces. */
  hash: string
  summary: string
}

export const DEFAULT_CONTEXT_WINDOW = 8192

/** Share of the window reserved for the model's own reply. */
const OUTPUT_RESERVE_RATIO = 0.2
const MIN_OUTPUT_RESERVE = 512
const MAX_OUTPUT_RESERVE = 4096

/** Blocks kept from the start (the original request) and the end (current state). */
const HEAD_BLOCKS = 1
const MIN_TAIL_BLOCKS = 2
const SUMMARY_TOKEN_BUDGET = 300

export class ContextBudgetError extends Error {
  constructor() { super('The current message and instructions exceed the available context budget. Shorten the message or Bot instructions and try again.') }
}

export function contextWindowOr(window: number | undefined): number {
  return window && window > 1024 ? window : DEFAULT_CONTEXT_WINDOW
}

/** Bound the application handoff to Codex; the CLI maintains its own history. */
export function applicationContextWindow(backendId: string, reported?: number): number | undefined {
  if (backendId !== 'codex') return reported
  return Math.min(reported && reported > 1024 ? reported : 32768, 32768)
}

/** Tokens available for everything we send. */
export function inputBudgetFor(contextWindow: number): number {
  const reserve = Math.min(
    MAX_OUTPUT_RESERVE,
    Math.max(MIN_OUTPUT_RESERVE, Math.floor(contextWindow * OUTPUT_RESERVE_RATIO))
  )
  return Math.max(1024, contextWindow - reserve)
}

/** Slice of the window a bot's memory may occupy. */
export function memoryBudgetFor(contextWindow: number): number {
  return Math.max(200, Math.min(1200, Math.floor(contextWindow * 0.15)))
}

export interface BudgetResult {
  messages: ProviderMessage[]
  /** How many history messages were replaced by the summary. */
  dropped: number
  estimatedTokens: number
  /** Fingerprint of the omitted region, when one was omitted. */
  omittedHash?: string
  /** Plain-text record of the omitted region, for background summarisation. */
  omittedText?: string
}

export function applyBudget(
  blocks: HistoryBlock[],
  systemTokens: number,
  contextWindow: number,
  semantic?: SemanticRegionSummary
): BudgetResult {
  const budget = inputBudgetFor(contextWindow)
  const flat = blocks.flatMap((block) => block.messages)
  const total = systemTokens + estimateMessagesTokens(flat)
  if (total <= budget) return { messages: flat, dropped: 0, estimatedTokens: total }

  const head = blocks.slice(0, HEAD_BLOCKS)
  const rest = blocks.slice(HEAD_BLOCKS)

  let used = systemTokens + sumTokens(head) + SUMMARY_TOKEN_BUDGET
  const tail: HistoryBlock[] = []
  for (let i = rest.length - 1; i >= 0; i--) {
    const block = rest[i]
    const fits = used + block.tokens <= budget
    const belowMinimum = tail.length < MIN_TAIL_BLOCKS
    if (!fits && !belowMinimum) break
    tail.unshift(block)
    used += block.tokens
  }

  const omitted = rest.slice(0, rest.length - tail.length)
  const kept = [...head.flatMap((block) => block.messages)]
  if (omitted.length > 0) {
    const omittedHash = regionHash(omitted)
    kept.push(summaryMessage(omitted, omittedHash, semantic))
  }
  kept.push(...tail.flatMap((block) => block.messages))

  const messages = fitMessages(kept, systemTokens, budget)
  const dropped = omitted.reduce((n, block) => n + block.messages.length, 0)
  const result: BudgetResult = { messages, dropped, estimatedTokens: systemTokens + estimateMessagesTokens(messages) }
  if (omitted.length > 0) {
    result.omittedHash = regionHash(omitted)
    result.omittedText = omittedText(omitted)
  }
  return result
}

/** Fingerprint of an omitted region; the cache key for its semantic summary. */
export function regionHash(omitted: HistoryBlock[]): string {
  return createHash('sha256').update(JSON.stringify(omitted.flatMap((block) => block.messages.map((message) => [message.role, textOf(message)])))).digest('hex')
}

function omittedText(omitted: HistoryBlock[]): string {
  const lines = omitted.flatMap((block) => block.messages.map((message) => `${message.role}: ${textOf(message).slice(0, 1200)}`))
  return fitToTokens(lines.join('\n'), 6000)
}

function sumTokens(blocks: HistoryBlock[]): number {
  return blocks.reduce((n, block) => n + block.tokens, 0)
}

/** Below this a message says nothing at all, so trimming it further is pointless. */
const MIN_MESSAGE_TOKENS = 40

/**
 * Last resort: shrink message text until what we send actually fits.
 *
 * Dropping whole blocks cannot get there on its own. The newest blocks are
 * forced in unconditionally — the model has to see the current state, and a
 * request with no recent turns is useless — so one long turn against a small
 * window overflows however much history is dropped. That is not a soft
 * overrun: `applyBudget` returned 12,348 estimated tokens against an 8,192
 * window, and a direct model API answers that with a hard "prompt too long"
 * rather than trimming for us.
 *
 * Oldest first, so the request being answered is the last thing to lose detail.
 */
function fitMessages(
  messages: ProviderMessage[],
  systemTokens: number,
  budget: number
): ProviderMessage[] {
  const out = [...messages]
  const latestUser = out.findLastIndex(message => message.role === 'user')

  // The second pass drops the per-message floor: an overrun that survives the
  // first is one the floors themselves are causing, and a prompt the backend
  // refuses outright is worse than a thin one.
  for (const floor of [MIN_MESSAGE_TOKENS, 0]) {
    let used = systemTokens + estimateMessagesTokens(out)
    if (used <= budget) break
    for (let i = 0; i < out.length && used > budget; i++) {
      // Never silently turn the actual request into an ellipsis. If even the
      // remaining instructions and request cannot fit, report the failure.
      if (i === latestUser) continue
      const before = estimateMessageTokens(out[i])
      const target = Math.max(floor, before - (used - budget))
      if (target >= before) continue
      out[i] = shrink(out[i], target)
      used -= before - estimateMessageTokens(out[i])
    }
  }
  if (systemTokens + estimateMessagesTokens(out) > budget && latestUser >= 0) {
    throw new ContextBudgetError()
  }
  return out
}

/**
 * One message reduced to plain text costing at most `maxTokens` in total.
 *
 * Total, not text: the role envelope and any tool-call arguments are charged
 * for too and cannot be trimmed, so budgeting only the text left the result
 * reliably a few tokens over and the loop above unable to close the gap.
 *
 * Images and reasoning go with the text. An image is a flat 800 tokens that
 * cannot be made smaller, and the reasoning trace is the least load-bearing
 * part of a turn we are already having to cut.
 */
function shrink(message: ProviderMessage, maxTokens: number): ProviderMessage {
  const text = textOf(message)
  const fixed = estimateMessageTokens({ ...message, content: '', reasoning: undefined })
  const room = Math.max(0, maxTokens - fixed - estimateTokens(TRIMMED_NOTE))
  return { ...message, content: `${fitToTokens(text, room)}${TRIMMED_NOTE}`, reasoning: undefined }
}

const TRIMMED_NOTE = '\n[trimmed to fit the context window]'

/**
 * Summary of the omitted middle. Uses the cached semantic summary when the
 * fingerprint matches the exact region being dropped; otherwise condenses
 * the region extractively. No model call happens here, so it cannot fail,
 * cost anything, or send the dropped content anywhere.
 */
function summaryMessage(omitted: HistoryBlock[], omittedHash: string, semantic?: SemanticRegionSummary): ProviderMessage {
  const messageCount = omitted.reduce((n, block) => n + block.messages.length, 0)
  const header = `[Earlier conversation trimmed to fit the context window: ${messageCount} messages omitted.]`
  if (semantic && semantic.hash === omittedHash && semantic.summary.trim()) {
    const content = `${header}\n${semantic.summary.trim()}`
    return { role: 'system', content: fitToTokens(content, Math.max(SUMMARY_TOKEN_BUDGET, estimateTokens(semantic.summary))) }
  }

  const lines: string[] = [header, 'Condensed record of the omitted part:']

  const perBlock = Math.max(1, Math.floor(SUMMARY_TOKEN_BUDGET / Math.max(1, omitted.length)))
  for (const block of omitted) {
    const line = block.summary.trim()
    if (line) lines.push(`- ${fitToTokens(oneLine(line, 400), perBlock)}`)
  }

  return { role: 'system', content: fitToTokens(lines.join('\n'), SUMMARY_TOKEN_BUDGET) }
}

export function tokensOfText(text: string): number {
  return estimateTokens(text)
}
