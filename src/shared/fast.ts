/**
 * Fast lane for one Bot's conversation model.
 *
 * A Fast switch only appears for providers with a real, documented fast
 * channel, and the chosen model must accept it. Every other backend hides
 * the switch entirely — nothing is guessed or sent on a model that would
 * reject it.
 */

export type FastWire = 'openai' | 'openrouter'

const WIRES: Record<string, FastWire> = {
  openai: 'openai',
  openrouter: 'openrouter'
}

export function fastWire(backendId: string): FastWire | null {
  return WIRES[backendId] ?? null
}

/**
 * Whether the chosen model accepts the fast channel on this backend.
 *
 * OpenRouter routes the suffix itself and no-ops for single-provider
 * models. OpenAI's paid fast lane covers the reasoning-capable families;
 * other models reject the tier, so the switch stays hidden for them.
 */
export function modelAcceptsFast(backendId: string, modelId: string): boolean {
  const wire = fastWire(backendId)
  if (!wire) return false
  const model = modelId.trim()
  if (!model || model === 'default') return false
  if (wire === 'openrouter') return true
  return /^(o\d|gpt-[5-9])/i.test(model)
}

/**
 * OpenRouter's provider-side fast lane: the documented `:nitro` routing
 * suffix. The model id itself stays the router slot the user picked.
 */
export function fastModelVariant(backendId: string, modelId: string, fast?: boolean): string {
  if (!fast || fastWire(backendId) !== 'openrouter' || !modelAcceptsFast(backendId, modelId)) return modelId
  return modelId.includes(':') ? modelId : `${modelId}:nitro`
}

/** OpenAI's paid fast lane. Omitted when the model would reject the tier. */
export function fastServiceTier(backendId: string, modelId: string, fast?: boolean): Record<string, unknown> | undefined {
  if (!fast || fastWire(backendId) !== 'openai' || !modelAcceptsFast(backendId, modelId)) return undefined
  return { service_tier: 'priority' }
}
