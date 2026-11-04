/**
 * Popular API-key providers the Add sheet can search.
 *
 * Names follow the public catalogs people already look for. Each row is an
 * official host this app already knows how to call. Nothing here is copied
 * from another product's source.
 */

export type ProviderProtocol = 'openai' | 'anthropic'

export interface ProviderCatalogEntry {
  id: string
  label: string
  protocol: ProviderProtocol
  /** Official API root. The key is only sent to this origin. */
  baseUrl: string
  /** Where a person creates a key. Shown in the row, not requested by us. */
  keyHint: string
  /** Extra words the Add sheet matches: Chinese names, product names, aliases. */
  keywords: string
}

export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  { id: 'openai', label: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', keyHint: 'platform.openai.com/api-keys', keywords: 'openai gpt chatgpt' },
  { id: 'anthropic', label: 'Anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', keyHint: 'console.anthropic.com/settings/keys', keywords: 'anthropic claude' },
  { id: 'gemini', label: 'Google Gemini', protocol: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyHint: 'aistudio.google.com/apikey', keywords: 'google gemini gemma' },
  { id: 'xai', label: 'xAI', protocol: 'openai', baseUrl: 'https://api.x.ai/v1', keyHint: 'console.x.ai', keywords: 'xai grok' },
  { id: 'openrouter', label: 'OpenRouter', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', keyHint: 'openrouter.ai/keys', keywords: 'openrouter router' },
  { id: 'groq', label: 'Groq', protocol: 'openai', baseUrl: 'https://api.groq.com/openai/v1', keyHint: 'console.groq.com/keys', keywords: 'groq' },
  { id: 'deepseek', label: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com', keyHint: 'platform.deepseek.com/api_keys', keywords: 'deepseek 深度求索' },
  { id: 'mistral', label: 'Mistral', protocol: 'openai', baseUrl: 'https://api.mistral.ai/v1', keyHint: 'console.mistral.ai', keywords: 'mistral' },
  { id: 'together', label: 'Together', protocol: 'openai', baseUrl: 'https://api.together.xyz/v1', keyHint: 'api.together.ai', keywords: 'together' },
  { id: 'fireworks', label: 'Fireworks', protocol: 'openai', baseUrl: 'https://api.fireworks.ai/inference/v1', keyHint: 'fireworks.ai/account/api-keys', keywords: 'fireworks' },
  { id: 'moonshot', label: 'Moonshot', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1', keyHint: 'platform.moonshot.cn', keywords: 'moonshot kimi 月之暗面' },
  { id: 'dashscope', label: 'Alibaba DashScope', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', keyHint: 'dashscope.console.aliyun.com', keywords: 'dashscope qwen 通义 阿里云 alibaba' },
  { id: 'zhipu', label: 'Zhipu', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', keyHint: 'open.bigmodel.cn', keywords: 'zhipu glm 智谱 智谱清言' },
  { id: 'minimax', label: 'MiniMax', protocol: 'openai', baseUrl: 'https://api.minimax.chat/v1', keyHint: 'platform.minimaxi.com', keywords: 'minimax 海螺' },
  { id: 'siliconflow', label: 'SiliconFlow', protocol: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', keyHint: 'cloud.siliconflow.cn', keywords: 'siliconflow 硅基流动' },
  { id: 'stepfun', label: 'StepFun', protocol: 'openai', baseUrl: 'https://api.stepfun.com/v1', keyHint: 'platform.stepfun.com', keywords: 'stepfun 阶跃' },
  { id: 'volcengine', label: 'Volcengine Ark', protocol: 'openai', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', keyHint: 'console.volcengine.com/ark', keywords: 'volcengine ark doubao 火山 方舟 豆包' },
  { id: 'deepinfra', label: 'DeepInfra', protocol: 'openai', baseUrl: 'https://api.deepinfra.com/v1/openai', keyHint: 'deepinfra.com', keywords: 'deepinfra' },
  { id: 'cerebras', label: 'Cerebras', protocol: 'openai', baseUrl: 'https://api.cerebras.ai/v1', keyHint: 'cloud.cerebras.ai', keywords: 'cerebras' },
  { id: 'sambanova', label: 'SambaNova', protocol: 'openai', baseUrl: 'https://api.sambanova.ai/v1', keyHint: 'cloud.sambanova.ai', keywords: 'sambanova' },
  { id: 'nvidia', label: 'NVIDIA', protocol: 'openai', baseUrl: 'https://integrate.api.nvidia.com/v1', keyHint: 'build.nvidia.com', keywords: 'nvidia nim' },
  { id: 'huggingface', label: 'Hugging Face', protocol: 'openai', baseUrl: 'https://router.huggingface.co/v1', keyHint: 'huggingface.co/settings/tokens', keywords: 'huggingface hf 抱抱脸' },
  { id: 'perplexity', label: 'Perplexity', protocol: 'openai', baseUrl: 'https://api.perplexity.ai', keyHint: 'perplexity.ai/settings/api', keywords: 'perplexity sonar' },
  { id: 'cohere', label: 'Cohere', protocol: 'openai', baseUrl: 'https://api.cohere.ai/compatibility/v1', keyHint: 'dashboard.cohere.com/api-keys', keywords: 'cohere' },
  { id: 'github-models', label: 'GitHub Models', protocol: 'openai', baseUrl: 'https://models.github.ai/inference', keyHint: 'github.com/settings/tokens', keywords: 'github models copilot' }
]

const BY_ID = new Map(PROVIDER_CATALOG.map((entry) => [entry.id, entry]))

export function providerById(id: string): ProviderCatalogEntry {
  const found = BY_ID.get(id)
  if (!found) throw new Error(`unknown provider: ${id}`)
  return found
}

export interface CatalogSearchable {
  id: string
  label: string
  keywords: string
}

/** Case-insensitive match on the label, id, and extra keywords. Blank query keeps catalog order. */
export function filterCatalog<T extends CatalogSearchable>(items: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...items]
  return items.filter((item) => `${item.label} ${item.id} ${item.keywords}`.toLowerCase().includes(q))
}
