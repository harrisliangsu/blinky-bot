import { useEffect, useState, type ReactNode } from 'react'
import { useShortcuts } from './lib/useShortcuts'
import { useTheme } from './lib/useTheme'
import { boot, selectSession, useAppState } from './state'
import { AppHeader } from './components/AppHeader'
import { ActivityPanel } from './components/ActivityPanel'
import { BotManager } from './components/BotManager'
import { CreateBotDialog } from './components/CreateBotDialog'
import { BotDetailsPanel } from './components/BotDetailsPanel'
import { AgentMainSurface, AgentSessionWorkspace } from './components/AgentSessionWorkspace'
import { CommandPalette } from './components/CommandPalette'
import { Composer } from './components/Composer'
import { ErrorBoundary } from './components/ErrorBoundary'
import { RightRail } from './components/RightRail'
import { RoutinePanel } from './components/RoutinePanel'
import { RoomsPanel } from './components/RoomsPanel'
import { SettingsPanel } from './components/SettingsPanel'
import { Sidebar } from './components/Sidebar'
import { StartupScreen } from './components/StartupScreen'
import { Toast } from './components/Toast'
import { Transcript } from './components/Transcript'
import { Workspace } from './components/Workspace'
import './App.css'

/** Application shell: navigation, conversation, side panel and overlays. */
export default function App(): ReactNode {
  const [botDetailsOpen, setBotDetailsOpen] = useState(false)
  const remoteCompact = (): boolean => window.openbot.environment?.kind === 'browser' && innerWidth < 760
  const [sidebarOpen, setSidebarOpen] = useState(() => !remoteCompact())
  const { ready, bootError, settings, modal, botDraftId, railOpen, approvals, workspace, currentSessionId } =
    useAppState()

  useEffect(() => {
    void boot()
  }, [])

  useEffect(() => {
    const toggleSidebar = (): void => {
      const focusWasInSidebar = Boolean(document.activeElement?.closest('.ob-sidebar'))
      setSidebarOpen((open) => !open)
      if (focusWasInSidebar) window.requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('#ob-prompt')?.focus())
    }
    const focusSearch = (): void => {
      setSidebarOpen(true)
      window.requestAnimationFrame(() => {
        window.dispatchEvent(new Event('openbot:expand-sidebar-for-search'))
        window.requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.ob-side-search-input')?.focus())
      })
    }
    const close = (): void => { if (remoteCompact()) setSidebarOpen(false) }
    let compact = remoteCompact()
    const resize = (): void => { const next = remoteCompact(); if (next !== compact) { setSidebarOpen(!next); compact = next } }
    window.addEventListener('openbot:close-sidebar', close)
    window.addEventListener('resize', resize)
    window.addEventListener('openbot:focus-bot-search', focusSearch)
    window.addEventListener('openbot:toggle-sidebar', toggleSidebar)
    return () => {
      window.removeEventListener('openbot:close-sidebar', close)
      window.removeEventListener('resize', resize)
      window.removeEventListener('openbot:focus-bot-search', focusSearch)
      window.removeEventListener('openbot:toggle-sidebar', toggleSidebar)
    }
  }, [])

  useEffect(() => {
    if (window.openbot.environment?.kind === 'browser') return
    const update = (): void => { void window.openbot.window.chromeLayout(document.querySelector('.ob-sidebar')?.getBoundingClientRect().width ?? 0).catch(() => {}) }
    update(); const observer = new ResizeObserver(update); const sidebar = document.querySelector('.ob-sidebar'); if (sidebar) observer.observe(sidebar)
    return () => observer.disconnect()
  }, [sidebarOpen, ready])

  useTheme(settings ?? undefined)
  useShortcuts(botDetailsOpen, () => setBotDetailsOpen(false))

  if (!ready || bootError) return <StartupScreen error={bootError} />

  const elsewhere = approvals.find((request) => request.sessionId !== currentSessionId)

  return (
    <ErrorBoundary>
    <AgentSessionWorkspace>
    <div className="ob-app">
      {sidebarOpen ? <><button type="button" className="ob-sidebar-backdrop" aria-label={settings?.language === 'en' ? 'Close navigation' : '关闭导航'} onClick={() => setSidebarOpen(false)} /><Sidebar /></> : null}

      <main className={`ob-main${!workspace.open && !elsewhere ? ' is-chat' : ''}`}>
        <AgentMainSurface>
        <AppHeader sidebarOpen={sidebarOpen} onToggleSidebar={() => window.dispatchEvent(new Event('openbot:toggle-sidebar'))} botDetailsOpen={botDetailsOpen} onToggleBotDetails={() => setBotDetailsOpen((open) => !open)} />
        {elsewhere ? <button type="button" className="ob-btn ob-btn-sm ob-approval-elsewhere" onClick={() => void selectSession(elsewhere.sessionId)}>{settings?.language === 'en' ? 'Another conversation needs confirmation' : '有对话需要确认，点击查看'}</button> : null}
        {workspace.open ? (
          /* Several chats at once (Alt+G). The composer stays: it writes to
             whichever pane has focus, which is the app's current session. */
          <>
            <Workspace />
            <Composer key={currentSessionId ?? 'none'} />
          </>
        ) : (
          <>
            <Transcript />
            <Composer key={currentSessionId ?? 'none'} />
          </>
        )}
        </AgentMainSurface>
      </main>

      {railOpen ? <RightRail /> : null}
      {botDetailsOpen ? <BotDetailsPanel onClose={() => setBotDetailsOpen(false)} /> : null}

      {modal === 'settings' ? <SettingsPanel /> : null}
      {modal === 'bots' ? (botDraftId === 'new' || botDraftId?.startsWith('new:') ? <CreateBotDialog key={botDraftId} templateId={botDraftId.startsWith('new:') ? botDraftId.slice(4) : undefined} /> : <BotManager />) : null}
      {modal === 'routines' ? <RoutinePanel /> : null}
      {modal === 'activity' ? <ActivityPanel /> : null}
      {modal === 'rooms' ? <RoomsPanel /> : null}
      <CommandPalette />

      <Toast />
    </div>
    </AgentSessionWorkspace>
    </ErrorBoundary>
  )
}
