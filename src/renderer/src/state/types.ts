import type {
  ApprovalRequest,
  ActivityItem,
  AgentTask,
  AgentGroup,
  CollaborationRoom,
  BackendInfo,
  Board,
  Bot,
  MemoryEntry,
  HumanHelpRequest,
  ProjectSummary,
  ProjectTag,
  RecordingState,
  Routine,
  RoutineStep,
  Session,
  SessionSummary,
  Settings,
  Skill,
  TodoItem
} from '../../../shared/types'
import type { LayoutPreset } from '../lib/paneLayout'

/** A session minus its message list — messages live in their own registry. */
export type SessionMeta = Omit<Session, 'messages' | 'todos'>

export type ModalName = 'settings' | 'bots' | 'routines' | 'palette' | 'project' | 'board' | 'computer' | 'activity' | 'rooms' | null

export interface RecordingUi {
  state: RecordingState
  stepCount: number
  steps: RoutineStep[]
  botId: string | null
  name: string
}

export interface ToastUi {
  text: string
  kind: 'info' | 'error'
}

/** Multi-pane workspace: which chats tile side by side, and which one is live. */
export interface WorkspaceUi {
  open: boolean
  preset: LayoutPreset
  /** One entry per slot in the active preset; null is an empty slot. */
  panes: (string | null)[]
  /** The pane that owns the current session, the composer and the stream. */
  focused: number
}

export interface AppState {
  ready: boolean
  bootError: string | null

  sessions: SessionSummary[]
  sessionsLoading: boolean
  sessionsError: string | null

  currentSessionId: string | null
  session: SessionMeta | null
  sessionLoading: boolean
  messageIds: string[]
  todos: TodoItem[]
  streaming: boolean
  /** Context accounting for the active session, as the backend reported it. */
  usage: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    cachedInputTokens?: number
    contextWindow?: number
  } | null
  runError: string | null

  bots: Bot[]
  groups: AgentGroup[]
  botsError: string | null
  memories: Record<string, MemoryEntry[]>

  /** Projects, newest first, as the main process summarised them. */
  projects: ProjectSummary[]
  projectsError: string | null
  /** Selected project — filters the conversation list and owns the open board. */
  currentProjectId: string | null
  board: Board | null
  boardLoading: boolean
  /** Tag chip currently narrowing the project list; null means all. */
  projectFilter: ProjectTag | null
  /** Project being edited: an id, `new`, or null when the editor is closed. */
  projectDraftId: string | null
  /** Project whose home page is showing in the main pane, instead of a chat. */
  projectHome: string | null

  /** Skills discovered across every CLI's directory plus the shared one. */
  skills: Skill[]
  skillsLoading: boolean
  skillsError: string | null

  routines: Routine[]
  routinesError: string | null
  recording: RecordingUi

  backends: BackendInfo[]
  backendsLoading: boolean
  backendsError: string | null

  settings: Settings | null
  settingsError: string | null

  approvals: ApprovalRequest[]
  helpRequests: HumanHelpRequest[]
  activity: ActivityItem[]
  tasks: AgentTask[]
  rooms: CollaborationRoom[]
  computerFrame: { screenshot: string; at: number; botId: string | null } | null
  computerActive: boolean
  lastClick: { x: number; y: number; at: number; botId: string | null } | null

  modal: ModalName
  botDraftId: string | null
  railOpen: boolean
  toast: ToastUi | null
  workspace: WorkspaceUi
}

export const EMPTY_IDS: string[] = []
export const EMPTY_TODOS: TodoItem[] = []

export const initialState: AppState = {
  ready: false,
  bootError: null,
  sessions: [],
  sessionsLoading: true,
  sessionsError: null,
  currentSessionId: null,
  session: null,
  sessionLoading: false,
  messageIds: EMPTY_IDS,
  todos: EMPTY_TODOS,
  streaming: false,
  usage: null,
  runError: null,
  bots: [],
  groups: [],
  botsError: null,
  memories: {},
  projects: [],
  projectsError: null,
  currentProjectId: null,
  board: null,
  boardLoading: false,
  projectFilter: null,
  projectDraftId: null,
  projectHome: null,
  skills: [],
  skillsLoading: false,
  skillsError: null,
  routines: [],
  routinesError: null,
  recording: { state: 'idle', stepCount: 0, steps: [], botId: null, name: '' },
  backends: [],
  backendsLoading: true,
  backendsError: null,
  settings: null,
  settingsError: null,
  approvals: [],
  helpRequests: [],
  activity: [],
  tasks: [],
  rooms: [],
  computerFrame: null,
  computerActive: false,
  lastClick: null,
  modal: null,
  botDraftId: null,
  railOpen: false,
  toast: null,
  // The stored preset is read when the workspace opens, not at module load.
  workspace: { open: false, preset: 'single', panes: [null], focused: 0 }
}
