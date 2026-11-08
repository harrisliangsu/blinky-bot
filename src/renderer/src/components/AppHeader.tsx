import type { ReactNode } from 'react'
import { useSettingsCopy } from '../lib/useSettingsCopy'
import { useResolvedTheme } from '../lib/useTheme'
import { store, updateSettings, useAppState } from '../state'
import { IconMoon, IconSun } from './Icons'
import { BotAvatar } from './BotAvatar'
import { useBotChinese } from './BotUiLanguage'
import './AppHeader.css'

/** A Bot owns its continuous conversation; the header does not expose sessions. */
export function AppHeader({ sidebarOpen, onToggleSidebar, botDetailsOpen, onToggleBotDetails }: { sidebarOpen: boolean; onToggleSidebar: () => void; botDetailsOpen: boolean; onToggleBotDetails: () => void }): ReactNode {
  const { session, bots, settings } = useAppState()
  const bot = bots.find((item) => item.id === session?.activeBotId)
  const zh = useBotChinese()
  const copy = useSettingsCopy().general
  const resolved = useResolvedTheme(settings?.theme)
  const next = resolved === 'dark' ? 'light' : 'dark'
  return (
    <header className={`ob-header${sidebarOpen ? '' : ' is-sidebar-hidden'}`}>
      <div className="ob-header-left ob-no-drag"><button type="button" className="ob-icon-btn" aria-label={sidebarOpen ? (zh ? '收起侧边栏' : 'Hide sidebar') : (zh ? '展开侧边栏' : 'Show sidebar')} aria-expanded={sidebarOpen} onClick={onToggleSidebar} title={sidebarOpen ? (zh ? '收起侧边栏' : 'Hide sidebar') : (zh ? '展开侧边栏' : 'Show sidebar')}>☰</button></div>
      <div className="ob-header-title">
        {bot ? (
          <button type="button" className="ob-header-bot-trigger ob-no-drag" onClick={onToggleBotDetails}
            aria-label={zh ? `管理 ${bot.name}` : `Manage ${bot.name}`} aria-expanded={botDetailsOpen} aria-controls="ob-bot-details">
            <BotAvatar bot={bot} size="sm" /><span>{bot.name}</span><span aria-hidden="true" className="ob-header-bot-chevron">›</span>
          </button>
        ) : <h1>BlinkyBot</h1>}
      </div>
      <div className="ob-header-right ob-no-drag">
        <button type="button" className="ob-icon-btn" aria-label={zh ? '打开工作区导航' : 'Open workspace navigation'} title={zh ? '工作区' : 'Workspace'} onClick={() => store.setModal('navigation')}>⋯</button>
        {window.openbot.environment?.kind !== 'browser' ? <button type="button" className="ob-btn ob-btn-sm" data-connect-device onClick={() => store.setModal('rooms')}>{zh ? '连接设备' : 'Connect device'}</button> : null}
        <button
          type="button"
          className="ob-icon-btn"
          aria-label={next === 'light' ? copy.themeUseLight : copy.themeUseDark}
          title={next === 'light' ? copy.light : copy.dark}
          onClick={() => void updateSettings({ theme: next })}
        >
          {resolved === 'dark' ? <IconMoon size={13} /> : <IconSun size={13} />}
        </button>
      </div>
    </header>
  )
}
