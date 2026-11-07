/**
 * One OpenAI-compatible cloud provider, parameterized by the public catalog.
 *
 * The dedicated OpenAI, xAI, and OpenRouter adapters stay separate because
 * they have provider-specific listing or headers. Everyone else in the
 * catalog speaks the same chat-completions shape.
 */

import { type ProviderCatalogEntry } from '../../shared/providerCatalog'
import { detectCloud } from './cloudDetect'
import { LIST_TIMEOUT_MS, withTimeout } from './httpClient'
import { errorMessage } from './httpErrors'
import { type HostBoundKey, bindKeyToHost, bindCustomKey } from './keyHost'
import { isReasoningOnlyModel } from './modelMeta'
import { type OaEndpoint, listOpenAiModels, streamOpenAiChat, toModelInfo } from './openaiCompat'
import type { Backend, BackendConfig, ChatChunk, ChatRequest, DetectResult, ModelInfo } from './types'
import { trimTrailingSlash } from './urls'

function baseOf(spec: ProviderCatalogEntry, cfg: BackendConfig): string {
  return trimTrailingSlash(cfg.baseUrl?.trim() || spec.baseUrl)
}

function bound(spec: ProviderCatalogEntry, cfg: BackendConfig): HostBoundKey {
  if (spec.id.startsWith('custom-')) return bindCustomKey(baseOf(spec, cfg), cfg.apiKey, cfg.credentialOrigin)
  return bindKeyToHost(spec.id, spec.label, baseOf(spec, cfg), cfg.apiKey)
}

function endpoint(spec: ProviderCatalogEntry, cfg: BackendConfig): OaEndpoint {
  const key = bound(spec, cfg)
  return { baseUrl: key.baseUrl, apiKey: key.apiKey }
}

export function openAiCompatibleBackend(spec: ProviderCatalogEntry): Backend {
  return {
    id: spec.id,
    label: spec.label,
    kind: 'cloud-api',
    local: false,

    async detect(cfg: BackendConfig): Promise<DetectResult> {
      const key = bound(spec, cfg)
      if (key.withheld) return { status: 'error', detail: key.withheld }
      return detectCloud({
        label: spec.label,
        endpoint: endpoint(spec, cfg),
        keyHint: spec.keyHint
      })
    },

    async listModels(cfg: BackendConfig): Promise<ModelInfo[]> {
      const key = bound(spec, cfg)
      if (key.withheld) throw new Error(key.withheld)
      const ep = endpoint(spec, cfg)
      if (!ep.apiKey) return []
      try {
        const entries = await listOpenAiModels(ep, withTimeout(undefined, LIST_TIMEOUT_MS))
        return entries
          .map((entry) => toModelInfo(entry, { assumeTools: true }))
          .filter((model): model is ModelInfo => model !== null)
          .sort((a, b) => a.id.localeCompare(b.id))
      } catch (err) {
        throw new Error(`Could not list ${spec.label} models: ${errorMessage(err)}`)
      }
    },

    chat(req: ChatRequest, cfg: BackendConfig): AsyncIterable<ChatChunk> {
      const key = bound(spec, cfg)
      if (key.withheld) throw new Error(key.withheld)
      return streamOpenAiChat({
        ...endpoint(spec, cfg),
        model: req.model,
        messages: req.messages,
        tools: req.tools,
        temperature: req.temperature,
        allowTemperature: !isReasoningOnlyModel(req.model),
        signal: req.signal
      })
    }
  }
}
