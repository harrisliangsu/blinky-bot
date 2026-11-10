import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentTaskSummary } from '../../../shared/types'
import { selectSession, useAppState } from '../state'
import { AgentSessionView } from './AgentSessionView'
import { captureReturnFocus, restoreReturnFocus, type ReturnFocus } from './returnFocus'
import { taskBelongsToBot } from './agentTaskPresentation'

interface Selection { task: AgentTaskSummary; source: string; bot: string }
interface Navigation { selection: Selection | null; task: AgentTaskSummary | null; open: (task: AgentTaskSummary) => void; close: () => void }
const Context = createContext<Navigation | null>(null)

export function useAgentSessionWorkspace(): Navigation {
  const value = useContext(Context)
  if (!value) throw new Error('Agent session workspace is unavailable')
  return value
}

/** UI-only selection: never selects, resumes or writes an execution session. */
export function AgentSessionWorkspace({ children }: { children: ReactNode }): ReactNode {
  const { currentSessionId, session, tasks } = useAppState()
  const [selection, setSelection] = useState<Selection | null>(null)
  const returnTo = useRef<ReturnFocus | null>(null)
  const bot = session?.activeBotId
  useEffect(() => {
    // Register before the first paint can select a task. No transcript read.
    void window.openbot.sessions.watch?.('chat', currentSessionId).catch(() => {})
    return () => { void window.openbot.sessions.watch?.('chat', null).catch(() => {}) }
  }, [currentSessionId])
  const visible = selection?.source === currentSessionId && selection?.bot === bot ? selection : null
  const updated = visible ? tasks.find(task => task.id === visible.task.id) : null
  const current = visible ? updated && updated.updatedAt >= visible.task.updatedAt ? updated : visible.task : null
  const task = current && visible && current.sessionId === visible.task.sessionId && taskBelongsToBot(current, visible.bot) ? current : null
  const close = useCallback(() => {
    setSelection(null)
    const target = returnTo.current
    returnTo.current = null
    const fallback = document.querySelector<HTMLElement>('#ob-bot-details [role="tab"][aria-selected="true"]') ?? document.querySelector<HTMLElement>('.ob-header-bot-trigger')
    restoreReturnFocus(target?.element.isConnected ? target : fallback ? { element: fallback, keyboard: target?.keyboard ?? true } : null)
  }, [])
  useEffect(() => {
    if (selection && !visible) { setSelection(null); returnTo.current = null }
  }, [selection, visible])
  // Notification navigation also uncovers a task that overlays its source chat.
  // The preload retains a startup click until this workspace has mounted.
  useEffect(() => window.openbot.notifications.onOpen(({ sessionId }) => {
    close()
    void selectSession(sessionId)
  }), [close])
  const open = (next: AgentTaskSummary): void => {
    if (!currentSessionId || !bot || !taskBelongsToBot(next, bot)) return
    returnTo.current = captureReturnFocus()
    setSelection({ task: next, source: currentSessionId, bot })
  }
  return <Context.Provider value={{ selection: visible, task, open, close }}>{children}</Context.Provider>
}

/** Keep the original chat mounted, with geometry intact, while it is covered.
 * Its draft, scroll and incoming events remain scoped to the original chat. */
export function AgentMainSurface({ children }: { children: ReactNode }): ReactNode {
  const { selection, task, close } = useAgentSessionWorkspace()
  return <>
    <div className="ob-agent-main-underlay" inert={Boolean(selection)} aria-hidden={selection ? true : undefined} style={selection ? { visibility: 'hidden' } : undefined}>{children}</div>
    {selection ? <AgentSessionView key={`${selection.task.id}-${selection.task.sessionId}`} task={task} onClose={close} /> : null}
  </>
}
