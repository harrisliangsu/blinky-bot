/**
 * Which CLI or provider, model, and thinking depth a Bot actually runs.
 *
 * Existing followers are resolved once for migration. Pinned Bots keep their
 * own source and model; `default` delegates to the CLI or provider itself.
 */

import { isThinkingDepth, type ThinkingDepth } from './thinking'

export interface BindingBot {
  backendId: string
  modelId: string
  followsDefault?: boolean
  thinking?: ThinkingDepth
}

export interface BindingSettings {
  defaultBackendId: string
  defaultModelId: string
  defaultThinking?: ThinkingDepth
  backends: Record<string, { defaultModelId?: string; modelThinking?: Record<string, ThinkingDepth> } | undefined>
}

export interface BotBinding {
  backendId: string
  modelId: string
  followsDefault: boolean
  thinking?: ThinkingDepth
}

/** True when this Bot has not been pinned to its own CLI or provider. */
export function followsSettingsDefault(bot: BindingBot): boolean {
  if (bot.followsDefault === false) return false
  if (bot.followsDefault === true) return true
  return !bot.modelId || bot.modelId === 'default'
}

export function resolveBotBinding(bot: BindingBot, settings: BindingSettings): BotBinding {
  const followsDefault = followsSettingsDefault(bot)
  const backendId = (followsDefault ? settings.defaultBackendId : bot.backendId) || settings.defaultBackendId
  const cliDefault = settings.backends[backendId]?.defaultModelId?.trim()
  const own = (followsDefault ? settings.defaultModelId : bot.modelId)?.trim()
  const modelId = followsDefault && (!own || own === 'default') ? cliDefault || 'default' : own || 'default'
  const modelKey = modelId === 'default' ? cliDefault || 'default' : modelId
  // Connection preferences seed new/legacy followers only. An existing Bot's
  // empty depth means the CLI's default, just like an execution Agent's empty
  // depth; changing a connection must not change a pinned Bot at run time.
  const chosen = followsDefault
    ? settings.defaultThinking ?? settings.backends[backendId]?.modelThinking?.[modelKey]
    : bot.thinking
  const thinking = isThinkingDepth(chosen) ? chosen : undefined
  return { backendId, modelId, followsDefault, ...(thinking ? { thinking } : {}) }
}

/** Freeze a legacy follower's effective selection before global settings can change. */
export function snapshotBotBinding(bot: BindingBot, settings: BindingSettings): BotBinding {
  const binding = resolveBotBinding(bot, settings)
  // Old pinned Bots also resolved their "default" through the provider settings.
  const modelId = binding.modelId === 'default'
    ? settings.backends[binding.backendId]?.defaultModelId?.trim() || 'default'
    : binding.modelId
  return { ...binding, modelId, followsDefault: false }
}
