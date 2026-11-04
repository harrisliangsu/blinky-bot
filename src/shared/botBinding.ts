/**
 * Which CLI and model a Bot actually runs.
 *
 * Settings is the source of truth. A Bot that still says "CLI default" follows
 * the default CLI in Settings, even if an older chat picker left another CLI
 * on the Bot. A CLI's own default model wins over a stale per-Bot slug, so the
 * row in Settings and the process that answers are the same choice.
 */

export interface BindingBot {
  backendId: string
  modelId: string
  followsDefault?: boolean
}

export interface BindingSettings {
  defaultBackendId: string
  defaultModelId: string
  backends: Record<string, { defaultModelId?: string } | undefined>
}

export interface BotBinding {
  backendId: string
  modelId: string
  followsDefault: boolean
}

/** True when this Bot has not been pinned to its own CLI. */
export function followsSettingsDefault(bot: BindingBot): boolean {
  if (bot.followsDefault === false) return false
  if (bot.followsDefault === true) return true
  return !bot.modelId || bot.modelId === 'default'
}

export function resolveBotBinding(bot: BindingBot, settings: BindingSettings): BotBinding {
  const followsDefault = followsSettingsDefault(bot)
  const backendId = (followsDefault ? settings.defaultBackendId : bot.backendId) || settings.defaultBackendId
  const cliDefault = settings.backends[backendId]?.defaultModelId?.trim()
  const own = followsDefault ? settings.defaultModelId : bot.modelId
  const modelId = cliDefault || own || 'default'
  return { backendId, modelId, followsDefault }
}
