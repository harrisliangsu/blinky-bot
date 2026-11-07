import { resolveSettingsLang } from '../lib/settingsCopy'
import { useAppState } from '../state'

/** Use the same language resolution as Settings throughout the bot editor. */
export function useBotChinese(): boolean {
  const { settings } = useAppState()
  const system = typeof navigator === 'undefined' ? 'zh-CN' : navigator.language
  return resolveSettingsLang(settings?.language, system) === 'zh-CN'
}
