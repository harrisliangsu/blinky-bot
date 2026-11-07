import type { ModelInfo } from '../types'
import { THINKING_DEPTHS, type ThinkingDepth } from '../../../shared/thinking'

/**
 * `kimi provider list --json` exposes the configured model aliases. Its
 * providers table may contain credentials, so only the model table is read and
 * no raw output or provider settings are returned to the renderer or cache.
 */
export function parseKimiModels(output: string): ModelInfo[] {
  let value: unknown
  try { value = JSON.parse(output) } catch { return [] }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const models = (value as Record<string, unknown>).models
  if (!models || typeof models !== 'object' || Array.isArray(models)) return []
  const result: ModelInfo[] = []
  const seen = new Set<string>()
  for (const [rawAlias, raw] of Object.entries(models)) {
    const id = rawAlias.trim()
    if (!id || id === 'default' || seen.has(id) || id.length > 300 || id.startsWith('-') || /[\x00-\x1f\x7f]/.test(id)) continue
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const model = raw as Record<string, unknown>
    if (typeof model.provider !== 'string' || !model.provider.trim() || typeof model.model !== 'string' || !model.model.trim()) continue
    const context = model.maxContextSize
    const capabilities = Array.isArray(model.capabilities) ? model.capabilities : []
    // Only publish model-specific effort choices. Legacy ACP models may show
    // an on/max toggle yet reject effort values in set_config_option; missing
    // metadata must not become invented low/high/max choices.
    const efforts = model.supportEfforts
    const supportedThinking: ThinkingDepth[] = Array.isArray(efforts)
      ? THINKING_DEPTHS.filter(depth => efforts.includes(depth))
      : []
    seen.add(id)
    result.push({
      id,
      // The alias is what `kimi --model` expects and distinguishes providers.
      label: id,
      supportedThinking,
      ...(typeof context === 'number' && Number.isSafeInteger(context) && context > 0 ? { contextWindow: context } : {}),
      supportsTools: capabilities.includes('tool_use'),
      // Kimi ACP carries image bytes; only advertise models whose own provider
      // configuration explicitly says they accept image input.
      supportsVision: capabilities.includes('image_in')
    })
  }
  return result
}
