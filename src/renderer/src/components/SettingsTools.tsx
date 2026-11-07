import { useState, type ReactNode } from 'react'
import type { Settings } from '../../../shared/types'
import { resolveSettingsLang } from '../lib/settingsCopy'
import { SettingsMcp } from './SettingsMcp'
import { SettingsSkills } from './SettingsSkills'
import './SettingsTools.css'

/** MCP servers and skills. Apps does not own this. */
export function SettingsTools({ settings }: { settings: Settings }): ReactNode {
  const zh = resolveSettingsLang(settings.language, typeof navigator === 'undefined' ? 'zh-CN' : navigator.language) === 'zh-CN'
  const [tab, setTab] = useState<'skills' | 'mcp'>('skills')
  return (
    <div className="ob-set-stack" data-tools="">
      <p className="ob-hint ob-tools-intro">{zh
        ? '管理本机 MCP 服务器和技能；Bot 可用的工具取决于所选运行方式及其配置。'
        : 'Manage MCP servers and skills on this Mac. Availability depends on each Bot’s runtime and configuration.'}</p>
      <div className="ob-tools-tabs" role="tablist" aria-label={zh ? '工具类型' : 'Tool type'}>
        <button type="button" role="tab" aria-selected={tab === 'skills'} className="ob-btn ob-btn-sm" onClick={() => setTab('skills')}>Skills</button>
        <button type="button" role="tab" aria-selected={tab === 'mcp'} className="ob-btn ob-btn-sm" onClick={() => setTab('mcp')}>MCP</button>
      </div>
      <div role="tabpanel">{tab === 'skills' ? <SettingsSkills /> : <SettingsMcp settings={settings} />}</div>
    </div>
  )
}
