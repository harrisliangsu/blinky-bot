import { useState, type ReactNode } from 'react'
import type { Settings } from '../../../shared/types'
import { resolveSettingsLang } from '../lib/settingsCopy'
import { useSettingsCopy } from '../lib/useSettingsCopy'
import { SettingsMcp } from './SettingsMcp'
import { SettingsSkills } from './SettingsSkills'
import { SettingsToolSync } from './SettingsToolSync'
import './SettingsTools.css'

/** Tool consistency across Agents, plus MCP servers and skills. */
export function SettingsTools({ settings }: { settings: Settings }): ReactNode {
  const copy = useSettingsCopy().tools
  const zh = resolveSettingsLang(settings.language, typeof navigator === 'undefined' ? 'zh-CN' : navigator.language) === 'zh-CN'
  const [tab, setTab] = useState<'sync' | 'skills' | 'mcp'>('sync')
  return (
    <div className="ob-set-stack" data-tools="">
      <p className="ob-hint ob-tools-intro">{copy.intro}</p>
      <p className="ob-hint">{zh
        ? '按工具类型查看每个 Agent 的启用状态并保持同步；MCP 服务器和技能管理在对应页签。'
        : 'See each tool’s enablement across Agents by type and keep them in sync; MCP servers and skills live on their own tabs.'}</p>
      <div className="ob-tools-tabs" role="tablist" aria-label={zh ? '工具类型' : 'Tool type'}>
        <button type="button" role="tab" aria-selected={tab === 'sync'} className="ob-btn ob-btn-sm" onClick={() => setTab('sync')}>{zh ? '工具同步' : 'Consistency'}</button>
        <button type="button" role="tab" aria-selected={tab === 'skills'} className="ob-btn ob-btn-sm" onClick={() => setTab('skills')}>{zh ? '技能' : 'Skills'}</button>
        <button type="button" role="tab" aria-selected={tab === 'mcp'} className="ob-btn ob-btn-sm" onClick={() => setTab('mcp')}>MCP</button>
      </div>
      <div role="tabpanel">{tab === 'sync' ? <SettingsToolSync /> : tab === 'skills' ? <SettingsSkills /> : <SettingsMcp settings={settings} />}</div>
    </div>
  )
}
