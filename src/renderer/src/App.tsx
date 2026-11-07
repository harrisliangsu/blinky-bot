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
import { KanbanBoard } from './components/KanbanBoard'
import { ProjectEditor } from './components/ProjectEditor'
import { ErrorBoundary } from './components/ErrorBoundary'
import { ProjectView } from './components/ProjectView'
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
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const { ready, bootError, settings, modal, botDraftId, railOpen, approvals, projectHome, workspace, currentSessionId } =
    useAppState()

  useEffect(() => {
    if (!ready) return
    return window.openbot.notifications.onOpen(({ sessionId }) => { void selectSession(sessionId) })
  }, [ready])

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
    window.addEventListener('openbot:focus-bot-search', focusSearch)
    window.addEventListener('openbot:toggle-sidebar', toggleSidebar)
    return () => {
      window.removeEventListener('openbot:focus-bot-search', focusSearch)
      window.removeEventListener('openbot:toggle-sidebar', toggleSidebar)
    }
  }, [])

  useTheme(settings ?? undefined)
  useShortcuts(botDetailsOpen, () => setBotDetailsOpen(false))

  if (!ready || bootError) return <StartupScreen error={bootError} />

  const elsewhere = approvals.find((request) => request.sessionId !== currentSessionId || projectHome)

  return (
    <ErrorBoundary>
    <AgentSessionWorkspace>
    <div className="ob-app">
      {sidebarOpen ? <Sidebar /> : null}

      <main className={`ob-main${!projectHome && !workspace.open && !elsewhere ? ' is-chat' : ''}`}>
        <AgentMainSurface>
        <AppHeader sidebarOpen={sidebarOpen} onToggleSidebar={() => window.dispatchEvent(new Event('openbot:toggle-sidebar'))} botDetailsOpen={botDetailsOpen} onToggleBotDetails={() => setBotDetailsOpen((open) => !open)} />
        {elsewhere ? <button type="button" className="ob-btn ob-btn-sm ob-approval-elsewhere" onClick={() => void selectSession(elsewhere.sessionId)}>{settings?.language === 'en' ? 'Another conversation needs confirmation' : '有对话需要确认，点击查看'}</button> : null}
        {/* Selecting a project shows its home here instead of a transcript. */}
        {projectHome ? (
          <ProjectView />
        ) : workspace.open ? (
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
      {modal === 'project' ? <ProjectEditor /> : null}
      {modal === 'board' ? <KanbanBoard /> : null}
      {modal === 'activity' ? <ActivityPanel /> : null}
      {modal === 'rooms' ? <RoomsPanel /> : null}
      <CommandPalette />

      <Toast />
    </div>
    </AgentSessionWorkspace>
    </ErrorBoundary>
  )
}
