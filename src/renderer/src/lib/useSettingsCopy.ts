import { useAppState } from '../state'
import { resolveSettingsLang, settingsCopy, type SettingsCopy } from './settingsCopy'

export function useSettingsCopy(): SettingsCopy {
  const { settings } = useAppState()
  const system = typeof navigator === 'undefined' ? 'zh-CN' : navigator.language
  return settingsCopy(resolveSettingsLang(settings?.language, system))
}
