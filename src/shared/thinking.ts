/**
 * Thinking depth for one Bot.
 *
 * The same five steps are shown everywhere. Each backend that can actually
 * set a depth maps them onto its own wire value. A backend with no such
 * control is omitted from the picker, and a chosen depth is not sent to a
 * model that would reject it.
 */

export const THINKING_DEPTHS = ['off', 'low', 'medium', 'high', 'xhigh'] as const

export type ThinkingDepth = (typeof THINKING_DEPTHS)[number]

export type ThinkingWire = 'codex' | 'kimi' | 'openai' | 'anthropic' | 'openrouter'

const WIRES: Record<string, ThinkingWire> = {
  codex: 'codex',
  kimi: 'kimi',
  openai: 'openai',
  xai: 'openai',
  anthropic: 'anthropic',
  openrouter: 'openrouter'
}

export function isThinkingDepth(value: unknown): value is ThinkingDepth {
  return typeof value === 'string' && (THINKING_DEPTHS as readonly string[]).includes(value)
}

/** How this backend accepts a depth, or null when the picker should hide. */
export function thinkingWire(backendId: string): ThinkingWire | null {
  return WIRES[backendId] ?? null
}

/**
 * Whether the chosen model will accept a depth on this backend.
 *
 * Codex and Kimi resolve the model themselves. An unnamed cloud model is
 * left alone: sending `reasoning_effort` to a plain chat model is a 400.
 */
export function modelAcceptsThinking(backendId: string, modelId: string): boolean {
  const wire = thinkingWire(backendId)
  if (!wire) return false
  if (wire === 'codex' || wire === 'kimi' || wire === 'openrouter') return true
  const model = modelId.trim()
  if (!model || model === 'default') return false
  if (wire === 'anthropic') return /claude/i.test(model)
  return /^(o\d|gpt-[5-9]|grok-)/i.test(model)
}

/** Codex `turn/start` effort. `off` is the protocol's `none`. */
export function codexEffort(depth: ThinkingDepth | undefined): string | undefined {
  if (!depth) return undefined
  return depth === 'off' ? 'none' : depth
}

/**
 * Kimi Code reads `KIMI_MODEL_THINKING_EFFORT` for this process only.
 * It has no `--effort` flag; an unknown flag aborts the launch.
 * `off` is the value the CLI treats as thinking disabled.
 */
export function kimiThinkingEnv(depth: ThinkingDepth | undefined): Record<string, string> | undefined {
  if (!depth) return undefined
  return { KIMI_MODEL_THINKING_EFFORT: depth === 'off' ? 'off' : depth }
}

/** OpenAI and xAI chat-completions field. Omitted when the model would reject it. */
export function openaiReasoningBody(
  depth: ThinkingDepth | undefined,
  modelId: string,
  backendId: string
): Record<string, unknown> | undefined {
  if (!depth || thinkingWire(backendId) !== 'openai') return undefined
  if (!modelAcceptsThinking(backendId, modelId)) return undefined
  return { reasoning_effort: depth === 'off' ? 'none' : depth }
}

/** OpenRouter's reasoning object. The router drops it for models that ignore effort. */
export function openrouterReasoningBody(depth: ThinkingDepth | undefined): Record<string, unknown> | undefined {
  if (!depth) return undefined
  return { reasoning: { effort: depth === 'off' ? 'none' : depth } }
}

const ANTHROPIC_BUDGET: Record<Exclude<ThinkingDepth, 'off'>, number> = {
  low: 2048,
  medium: 4096,
  high: 16_000,
  xhigh: 32_000
}

/**
 * Anthropic extended thinking. `max_tokens` has to exceed the budget, so the
 * caller raises it to `minMaxTokens` when that is higher than the model default.
 */
export function anthropicThinking(depth: ThinkingDepth | undefined): {
  thinking?: Record<string, unknown>
  minMaxTokens?: number
} {
  if (!depth) return {}
  if (depth === 'off') return { thinking: { type: 'disabled' } }
  const budget = ANTHROPIC_BUDGET[depth]
  return { thinking: { type: 'enabled', budget_tokens: budget }, minMaxTokens: budget + 4096 }
}
