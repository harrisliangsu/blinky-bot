import type { ReactNode } from 'react'
import type { Settings } from '../../../shared/types'
import { useSettingsCopy } from '../lib/useSettingsCopy'
import { SettingsMcp } from './SettingsMcp'
import { SettingsSkills } from './SettingsSkills'
import './SettingsTools.css'

/** MCP servers and skills. Apps does not own this. */
export function SettingsTools({ settings }: { settings: Settings }): ReactNode {
  const copy = useSettingsCopy().tools
  return (
    <div className="ob-set-stack" data-tools="">
      <p className="ob-hint ob-tools-intro">{copy.intro}</p>
      <SettingsMcp settings={settings} />
      <SettingsSkills />
    </div>
  )
}
