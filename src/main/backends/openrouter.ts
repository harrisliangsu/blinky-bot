/**
 * OpenRouter — OpenAI-compatible aggregator, user-supplied API key only.
 *
 * Its `/models` listing reports modalities and supported parameters per model,
 * so vision and tool support come from the provider rather than inference.
 */

import { detectCloud } from './cloudDetect'
import { LIST_TIMEOUT_MS, withTimeout } from './httpClient'
import { errorMessage } from './httpErrors'
import { type HostBoundKey, bindKeyToHost } from './keyHost'
import { type OaEndpoint, listOpenAiModels, streamOpenAiChat, toModelInfo } from './openaiCompat'
import type { Backend, BackendConfig, ChatChunk, ChatRequest, DetectResult, ModelInfo } from './types'
import { ensureV1 } from './urls'

export const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'

/**
 * The key is bound to OpenRouter's own origin: a custom base URL pointing
 * anywhere else gets no `Authorization` header at all, and `withheld` says so.
 */
function bound(cfg: BackendConfig): HostBoundKey {
  const baseUrl = ensureV1(cfg.baseUrl?.trim() || OPENROUTER_DEFAULT_BASE_URL)
  return bindKeyToHost('openrouter', 'OpenRouter', baseUrl, cfg.apiKey)
}

function endpoint(cfg: BackendConfig): OaEndpoint {
  const { baseUrl, apiKey } = bound(cfg)
  return {
    baseUrl,
    apiKey,
    // Attribution header only; no identifying information about the machine.
    headers: { 'x-title': 'BlinkyBot' }
  }
}

export const openrouterBackend: Backend = {
  id: 'openrouter',
  label: 'OpenRouter',
  kind: 'cloud-api',
  local: false,

  async detect(cfg: BackendConfig): Promise<DetectResult> {
    const { withheld } = bound(cfg)
    if (withheld) return { status: 'error', detail: withheld }
    return detectCloud({
      label: 'OpenRouter',
      endpoint: endpoint(cfg),
      keyHint: 'openrouter.ai/keys',
      // `/key` validates the key itself and is far smaller than the model list.
      probePath: '/key'
    })
  },

  async listModels(cfg: BackendConfig): Promise<ModelInfo[]> {
    const { withheld } = bound(cfg)
    if (withheld) throw new Error(withheld)
    const ep = endpoint(cfg)
    if (!ep.apiKey) return []
    try {
      const entries = await listOpenAiModels(ep, withTimeout(undefined, LIST_TIMEOUT_MS))
      return entries
        .map((e) => toModelInfo(e))
        .filter((m): m is ModelInfo => m !== null)
        .sort((a, b) => a.id.localeCompare(b.id))
    } catch (err) {
      throw new Error(`Could not list OpenRouter models: ${errorMessage(err)}`)
    }
  },

  chat(req: ChatRequest, cfg: BackendConfig): AsyncIterable<ChatChunk> {
    const { withheld } = bound(cfg)
    if (withheld) throw new Error(withheld)
    return streamOpenAiChat({
      ...endpoint(cfg),
      model: req.model,
      messages: req.messages,
      tools: req.tools,
      temperature: req.temperature,
      signal: req.signal
    })
  }
}
