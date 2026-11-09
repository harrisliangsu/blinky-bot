/** OpenAI — user-supplied API key only, talking to OpenAI's own endpoint. */

import { detectCloud } from './cloudDetect'
import { LIST_TIMEOUT_MS, withTimeout } from './httpClient'
import { errorMessage } from './httpErrors'
import { type HostBoundKey, bindKeyToHost } from './keyHost'
import { openaiReasoningBody } from '../../shared/thinking'
import { fastServiceTier } from '../../shared/fast'
import { isReasoningOnlyModel } from './modelMeta'
import { type OaEndpoint, listOpenAiModels, streamOpenAiChat, toModelInfo } from './openaiCompat'
import type { Backend, BackendConfig, ChatChunk, ChatRequest, DetectResult, ModelInfo } from './types'
import { ensureV1 } from './urls'

export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1'

/**
 * The key is bound to OpenAI's own origin: a custom base URL pointing anywhere
 * else gets no `Authorization` header at all, and `withheld` says so.
 */
function bound(cfg: BackendConfig): HostBoundKey {
  const baseUrl = ensureV1(cfg.baseUrl?.trim() || OPENAI_DEFAULT_BASE_URL)
  return bindKeyToHost('openai', 'OpenAI', baseUrl, cfg.apiKey)
}

function endpoint(cfg: BackendConfig): OaEndpoint {
  const { baseUrl, apiKey } = bound(cfg)
  return { baseUrl, apiKey }
}

export const openaiBackend: Backend = {
  id: 'openai',
  label: 'OpenAI',
  kind: 'cloud-api',
  local: false,

  async detect(cfg: BackendConfig): Promise<DetectResult> {
    const { withheld } = bound(cfg)
    if (withheld) return { status: 'error', detail: withheld }
    return detectCloud({
      label: 'OpenAI',
      endpoint: endpoint(cfg),
      keyHint: 'platform.openai.com/api-keys'
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
        .map((e) => toModelInfo(e, { assumeTools: true }))
        .filter((m): m is ModelInfo => m !== null)
        .sort((a, b) => a.id.localeCompare(b.id))
    } catch (err) {
      throw new Error(`Could not list OpenAI models: ${errorMessage(err)}`)
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
      // Reasoning models reject sampling knobs outright.
      allowTemperature: !isReasoningOnlyModel(req.model),
      extraBody: { ...openaiReasoningBody(req.thinking, req.model, 'openai'), ...fastServiceTier('openai', req.model, req.fast) },
      signal: req.signal
    })
  }
}
