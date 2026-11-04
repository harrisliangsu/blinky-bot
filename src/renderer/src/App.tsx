import { useEffect, type ReactNode } from 'react'
import { useShortcuts } from './lib/useShortcuts'
import { useTheme } from './lib/useTheme'
import { boot, respondToApproval, useAppState } from './state'
import { AppHeader } from './components/AppHeader'
import { ApprovalDialog } from './components/ApprovalDialog'
import { ActivityPanel } from './components/ActivityPanel'
import { BotManager } from './components/BotManager'
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
  const { ready, bootError, settings, modal, railOpen, approvals, projectHome, workspace } =
    useAppState()

  useEffect(() => {
    void boot()
  }, [])

  useTheme(settings ?? undefined)
  useShortcuts()

  if (!ready || bootError) return <StartupScreen error={bootError} />

  const pending = approvals[0]

  return (
    <ErrorBoundary>
    <div className="ob-app">
      <Sidebar />

      <main className="ob-main">
        <AppHeader />
        {/* Selecting a project shows its home here instead of a transcript. */}
        {projectHome ? (
          <ProjectView />
        ) : workspace.open ? (
          /* Several chats at once (Alt+G). The composer stays: it writes to
             whichever pane has focus, which is the app's current session. */
          <>
            <Workspace />
            <Composer />
          </>
        ) : (
          <>
            <Transcript />
            <Composer />
          </>
        )}
      </main>

      {railOpen ? <RightRail /> : null}

      {modal === 'settings' ? <SettingsPanel /> : null}
      {modal === 'bots' ? <BotManager /> : null}
      {modal === 'routines' ? <RoutinePanel /> : null}
      {modal === 'project' ? <ProjectEditor /> : null}
      {modal === 'board' ? <KanbanBoard /> : null}
      {modal === 'activity' ? <ActivityPanel /> : null}
      {modal === 'rooms' ? <RoomsPanel /> : null}
      <CommandPalette />

      {pending ? (
        <ApprovalDialog
          key={pending.id}
          request={pending}
          queued={approvals.length - 1}
          onDecide={(decision) => void respondToApproval(pending.id, decision)}
        />
      ) : null}

      <Toast />
    </div>
    </ErrorBoundary>
  )
}
