/**
 * Which CLI or provider, model, and thinking depth a Bot actually runs.
 *
 * Settings is the fallback. A Bot that still says "use the default" follows
 * the default CLI, that CLI's default model, and the default thinking depth.
 * A Bot that picks its own source keeps the model it chose. `default` on a
 * pinned Bot still means that CLI or provider's model in Settings.
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
  backends: Record<string, { defaultModelId?: string } | undefined>
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
  const modelId = !own || own === 'default' ? cliDefault || own || 'default' : own
  const chosen = followsDefault ? settings.defaultThinking : bot.thinking
  const thinking = isThinkingDepth(chosen) ? chosen : undefined
  return { backendId, modelId, followsDefault, ...(thinking ? { thinking } : {}) }
}
