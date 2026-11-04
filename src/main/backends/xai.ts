/**
 * xAI (Grok) — OpenAI-compatible, user-supplied API key only.
 *
 * Its `/language-models` endpoint reports input modalities, which is a better
 * vision signal than guessing from the model id.
 */

import { openaiReasoningBody } from '../../shared/thinking'
import { detectCloud } from './cloudDetect'
import { LIST_TIMEOUT_MS, withTimeout } from './httpClient'
import { errorMessage } from './httpErrors'
import { type HostBoundKey, bindKeyToHost } from './keyHost'
import { type OaEndpoint, listOpenAiModels, streamOpenAiChat, toModelInfo } from './openaiCompat'
import type { Backend, BackendConfig, ChatChunk, ChatRequest, DetectResult, ModelInfo } from './types'
import { ensureV1 } from './urls'

export const XAI_DEFAULT_BASE_URL = 'https://api.x.ai/v1'

/**
 * The key is bound to xAI's own origin: a custom base URL pointing anywhere
 * else gets no `Authorization` header at all, and `withheld` says so.
 */
function bound(cfg: BackendConfig): HostBoundKey {
  const baseUrl = ensureV1(cfg.baseUrl?.trim() || XAI_DEFAULT_BASE_URL)
  return bindKeyToHost('xai', 'xAI', baseUrl, cfg.apiKey)
}

function endpoint(cfg: BackendConfig): OaEndpoint {
  const { baseUrl, apiKey } = bound(cfg)
  return { baseUrl, apiKey }
}

export const xaiBackend: Backend = {
  id: 'xai',
  label: 'xAI',
  kind: 'cloud-api',
  local: false,

  async detect(cfg: BackendConfig): Promise<DetectResult> {
    const { withheld } = bound(cfg)
    if (withheld) return { status: 'error', detail: withheld }
    return detectCloud({
      label: 'xAI',
      endpoint: endpoint(cfg),
      keyHint: 'console.x.ai'
    })
  },

  async listModels(cfg: BackendConfig): Promise<ModelInfo[]> {
    const { withheld } = bound(cfg)
    if (withheld) throw new Error(withheld)
    const ep = endpoint(cfg)
    if (!ep.apiKey) return []
    const signal = withTimeout(undefined, LIST_TIMEOUT_MS)
    try {
      const rich = await listOpenAiModels(ep, signal, '/language-models')
      if (rich.length) {
        return rich
          .map((e) => toModelInfo(e, { assumeTools: true }))
          .filter((m): m is ModelInfo => m !== null)
          .sort((a, b) => a.id.localeCompare(b.id))
      }
    } catch {
      // Older keys/plans only expose /models — fall through.
    }
    try {
      const entries = await listOpenAiModels(ep, signal)
      return entries
        .map((e) => toModelInfo(e, { assumeTools: true }))
        .filter((m): m is ModelInfo => m !== null)
        .sort((a, b) => a.id.localeCompare(b.id))
    } catch (err) {
      throw new Error(`Could not list xAI models: ${errorMessage(err)}`)
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
      extraBody: openaiReasoningBody(req.thinking, req.model, 'xai'),
      signal: req.signal
    })
  }
}
