/** Anthropic — user-supplied API key only, talking to Anthropic's own endpoint. */

import { anthropicThinking, modelAcceptsThinking } from '../../shared/thinking'
import { needsKey } from './cloudDetect'
import { DETECT_TIMEOUT_MS, LIST_TIMEOUT_MS, fetchJson, withTimeout } from './httpClient'
import { errorMessage, isOffline, keyRejectionDetail } from './httpErrors'
import { type HostBoundKey, bindKeyToHost } from './keyHost'
import { maxTokensFor, toAnthropicMessages, toAnthropicTools } from './anthropicMessages'
import { streamAnthropic } from './anthropicStream'
import type { Backend, BackendConfig, ChatChunk, ChatRequest, DetectResult, ModelInfo } from './types'
import { joinUrl, trimTrailingSlash } from './urls'

export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com'
export const ANTHROPIC_API_VERSION = '2023-06-01'

/** Only used when the live listing cannot be reached; aliases track the latest. */
const FALLBACK_MODELS = ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5']

interface AnthropicModelEntry {
  id?: string
  display_name?: string
}

function baseUrl(cfg: BackendConfig): string {
  return trimTrailingSlash(cfg.baseUrl?.trim() || ANTHROPIC_DEFAULT_BASE_URL)
}

/**
 * The key is bound to Anthropic's own origin: a custom base URL pointing
 * anywhere else gets no `x-api-key` header at all, and `withheld` says so.
 */
function bound(cfg: BackendConfig): HostBoundKey {
  return bindKeyToHost('anthropic', 'Anthropic', baseUrl(cfg), cfg.apiKey)
}

function headers(apiKey: string): Record<string, string> {
  return { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_API_VERSION }
}

function toModel(id: string, label?: string): ModelInfo {
  return {
    id,
    label: label || id,
    contextWindow: 200_000,
    supportsTools: true,
    supportsVision: true
  }
}

async function fetchModels(ep: HostBoundKey, signal: AbortSignal): Promise<AnthropicModelEntry[]> {
  const res = await fetchJson<{ data?: AnthropicModelEntry[] }>(
    joinUrl(ep.baseUrl, '/v1/models?limit=100'),
    { headers: headers(ep.apiKey ?? ''), signal }
  )
  return res.data ?? []
}

export const anthropicBackend: Backend = {
  id: 'anthropic',
  label: 'Anthropic',
  kind: 'cloud-api',
  local: false,

  async detect(cfg: BackendConfig): Promise<DetectResult> {
    const ep = bound(cfg)
    if (ep.withheld) return { status: 'error', detail: ep.withheld }
    if (!ep.apiKey) return needsKey('Anthropic', 'console.anthropic.com/settings/keys')
    try {
      const models = await fetchModels(ep, withTimeout(undefined, DETECT_TIMEOUT_MS))
      return {
        status: 'available',
        detail: models.length ? `Key accepted — ${models.length} models available.` : 'Key accepted.'
      }
    } catch (err) {
      const rejected = keyRejectionDetail(err, 'Anthropic')
      if (rejected) return { status: /429/.test(rejected) ? 'error' : 'needs-key', detail: rejected }
      if (isOffline(err)) {
        return { status: 'error', detail: 'Could not reach the Anthropic API — check your network connection.' }
      }
      return { status: 'error', detail: `Anthropic check failed: ${errorMessage(err)}` }
    }
  },

  async listModels(cfg: BackendConfig): Promise<ModelInfo[]> {
    const ep = bound(cfg)
    if (ep.withheld) throw new Error(ep.withheld)
    if (!ep.apiKey) return []
    try {
      const entries = await fetchModels(ep, withTimeout(undefined, LIST_TIMEOUT_MS))
      const models = entries
        .filter((e): e is AnthropicModelEntry & { id: string } => typeof e.id === 'string' && !!e.id)
        .map((e) => toModel(e.id, e.display_name))
      return models.length ? models : FALLBACK_MODELS.map((id) => toModel(id))
    } catch (err) {
      if (isOffline(err)) return FALLBACK_MODELS.map((id) => toModel(id))
      throw new Error(`Could not list Anthropic models: ${errorMessage(err)}`)
    }
  },

  chat(req: ChatRequest, cfg: BackendConfig): AsyncIterable<ChatChunk> {
    const ep = bound(cfg)
    if (ep.withheld) throw new Error(ep.withheld)
    const key = ep.apiKey
    if (!key) throw new Error('Anthropic API key required — add one in Settings.')

    const { system, messages } = toAnthropicMessages(req.messages)
    const thinking = modelAcceptsThinking('anthropic', req.model) ? anthropicThinking(req.thinking) : {}
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: Math.max(maxTokensFor(req.model), thinking.minMaxTokens ?? 0),
      messages
    }
    if (thinking.thinking) body.thinking = thinking.thinking
    if (system) body.system = system
    if (typeof req.temperature === 'number') body.temperature = req.temperature
    if (req.tools?.length) body.tools = toAnthropicTools(req.tools)

    return streamAnthropic({
      baseUrl: ep.baseUrl,
      apiKey: key,
      apiVersion: ANTHROPIC_API_VERSION,
      body,
      signal: req.signal
    })
  }
}
