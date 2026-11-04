/** The IPC surface exposed to the renderer as `window.openbot`. */

import type { Attachment } from './chat'
import type { AgentGroup, Bot, BotSaveResult, MemoryEntry } from './bots'
import type {
  ComputerProbeResult,
  ComputerTarget,
  HumanComputerAction,
  ScreenFrame,
  ScreenControlResult,
  VmAdminResult,
  VmProvisionStatus,
  VmProvisionResult
} from './computer'
import type { AppStatus } from './apps'
import type { BackendInfo } from './backends'
import type { AgentEvent } from './events'
import type { Board, BoardCard, Project, ProjectSummary } from './projects'
import type { Routine } from './routines'
import type { AgentMode, Session, SessionSummary } from './sessions'
import type { Settings } from './settings'
import type { UpdateReport } from './updates'
import type { Skill, SkillInstallOptions, SkillInstallResult, SkillUninstallResult } from './skills'
import type { ApprovalDecision } from './tools'
import type { SearchResult } from './search'
import type { ActivityItem, AgentTask } from './activity'
import type { CollaborationRoom } from './rooms'

export interface OpenBotApi {
  search: {
    /** Search local messages, files, links, conversations, bots, projects and routines. */
    query(text: string, limit?: number): Promise<SearchResult[]>
  }
  activity: {
    list(): Promise<ActivityItem[]>
    markRead(id?: string): Promise<void>
    clear(): Promise<void>
  }
  tasks: {
    list(): Promise<AgentTask[]>
    create(botId: string, prompt: string, title?: string): Promise<AgentTask | null>
    cancel(id: string): Promise<AgentTask | null>
  }
  rooms: {
    list(): Promise<CollaborationRoom[]>
    create(sessionId: string, name?: string): Promise<CollaborationRoom | null>
    remove(id: string): Promise<void>
  }
  sessions: {
    list(): Promise<SessionSummary[]>
    get(id: string): Promise<Session | null>
    create(botIds?: string[]): Promise<Session>
    rename(id: string, title: string): Promise<void>
    archive(id: string): Promise<void>
    /** Restore an archived chat. Archiving and restoring are separate: a
        toggle silently did nothing when the two sides disagreed. */
    unarchive(id: string): Promise<void>
    remove(id: string): Promise<void>
    setMode(id: string, mode: AgentMode): Promise<void>
    /** Choose the folder this chat works in. */
    setCwd(id: string, cwd: string): Promise<void>
    addBot(id: string, botId: string): Promise<void>
    removeBot(id: string, botId: string): Promise<void>
    /** Choose which bot answers the next turn in a multi-bot exchange. */
    setActiveBot(id: string, botId: string): Promise<void>
    /** File this chat into a project, or pass null to unfile it. */
    setProject(id: string, projectId: string | null): Promise<void>
    react(id: string, messageId: string, emoji: string, actor?: string): Promise<void>
  }
  /**
   * Projects and their boards. Board calls all return the whole board: a card
   * move is only meaningful against the board it landed in, and one round trip
   * beats reconciling a patch in the renderer. Null means the project, card or
   * column was not found.
   */
  projects: {
    list(): Promise<ProjectSummary[]>
    get(id: string): Promise<Project | null>
    create(partial: Partial<Project>): Promise<Project>
    update(id: string, patch: Partial<Project>): Promise<Project>
    remove(id: string): Promise<void>
    board(id: string): Promise<Board | null>
    addCard(projectId: string, columnId: string, card: Partial<BoardCard>): Promise<Board | null>
    updateCard(projectId: string, cardId: string, patch: Partial<BoardCard>): Promise<Board | null>
    /** Drag and drop, within a column or across columns. */
    moveCard(
      projectId: string,
      cardId: string,
      toColumnId: string,
      toIndex: number
    ): Promise<Board | null>
    removeCard(projectId: string, cardId: string): Promise<Board | null>
    addColumn(projectId: string, name: string): Promise<Board | null>
    renameColumn(projectId: string, columnId: string, name: string): Promise<Board | null>
    /** Mark a column as the one that holds finished work, or clear that. */
    setColumnDone(projectId: string, columnId: string, done: boolean): Promise<Board | null>
    /** Cards move to the first remaining column; the last column stays. */
    removeColumn(projectId: string, columnId: string): Promise<Board | null>
  }
  bots: {
    list(): Promise<Bot[]>
    get(id: string): Promise<Bot | null>
    create(partial: Partial<Bot>): Promise<BotSaveResult>
    update(id: string, patch: Partial<Bot>): Promise<BotSaveResult>
    duplicate(id: string): Promise<BotSaveResult>
    /** Verify an execution target before persisting it. */
    probeTarget(target: ComputerTarget, botId?: string): Promise<ComputerProbeResult>
    /** Create a private persistent local Linux VM using Apple's native runtime. */
    provisionTarget(): Promise<VmProvisionResult>
    /** Read/cancel first-use runtime, image-build, and VM-boot work. */
    provisionStatus(): Promise<VmProvisionStatus>
    cancelProvision(): Promise<VmProvisionStatus>
    /** Capture or directly control a bot's private screen for human takeover. */
    captureScreen(id: string): Promise<ScreenControlResult>
    controlScreen(id: string, action: HumanComputerAction): Promise<ScreenControlResult>
    /** Restart an OpenBOT-owned VM without deleting its files or browser profile. */
    restartTarget(id: string): Promise<ComputerProbeResult>
    /** Run a human-entered command as root inside an OpenBOT-owned VM. */
    runAdminCommand(id: string, command: string): Promise<VmAdminResult>
    /** Destroy a managed VM created for a draft that was not saved. */
    discardTarget(target: ComputerTarget): Promise<void>
    remove(id: string): Promise<void>
    memory(id: string): Promise<MemoryEntry[]>
    addMemory(id: string, text: string): Promise<MemoryEntry>
    removeMemory(id: string, entryId: string): Promise<void>
  }
  groups: {
    list(): Promise<AgentGroup[]>
    create(name: string): Promise<AgentGroup>
    update(id: string, patch: Partial<AgentGroup>): Promise<AgentGroup | null>
    remove(id: string): Promise<void>
  }
  routines: {
    list(botId?: string): Promise<Routine[]>
    get(id: string): Promise<Routine | null>
    /** Rename, re-describe, or switch replay mode after recording. */
    update(id: string, patch: Partial<Routine>): Promise<Routine>
    remove(id: string): Promise<void>
    run(id: string, sessionId: string): Promise<void>
    startRecording(botId: string, name: string): Promise<void>
    stopRecording(): Promise<Routine | null>
  }
  agent: {
    send(sessionId: string, text: string, attachments?: Attachment[]): Promise<void>
    stop(sessionId: string): Promise<void>
    respondToApproval(requestId: string, decision: ApprovalDecision): Promise<void>
    /** Resume a turn paused by request_help after the user returns VM control. */
    returnControl(requestId: string): Promise<boolean>
  }
  backends: {
    list(): Promise<BackendInfo[]>
    refresh(): Promise<BackendInfo[]>
    /** Re-probe one CLI's install and sign-in state. */
    recheck(id: string): Promise<BackendInfo[]>
    /** Open Terminal with that CLI's own login. No credential is stored here. */
    login(id: string): Promise<{ started: boolean }>
  }
  /** GitHub, Git, and Gmail. One connection, shared by every Bot. */
  apps: {
    status(): Promise<AppStatus[]>
    connectGitHub(): Promise<{ started: boolean }>
    connectGit(name: string, email: string): Promise<AppStatus>
    requestGmail(): Promise<AppStatus>
  }
  skills: {
    /** Everything installed, across every CLI's directory plus the shared one. */
    list(cwd?: string): Promise<Skill[]>
    refresh(cwd?: string): Promise<Skill[]>
    /** Only what this backend's CLI can actually see, deduped by preference. */
    forBackend(backendId: string, cwd?: string): Promise<Skill[]>
    /** Copies a folder into the shared directory so every CLI can use it. */
    install(sourcePath: string, opts?: SkillInstallOptions): Promise<SkillInstallResult>
    uninstall(id: string): Promise<SkillUninstallResult>
  }
  settings: {
    get(): Promise<Settings>
    update(patch: Partial<Settings>): Promise<Settings>
  }
  dialog: {
    pickDirectory(): Promise<string | null>
    pickFiles(): Promise<string[]>
  }
  window: {
    /** Enter or leave native OS full screen and report the resulting state. */
    setFullScreen(active: boolean): Promise<boolean>
    isFullScreen(): Promise<boolean>
  }
  updates: {
    version(): Promise<string>
    check(channel: 'stable' | 'beta'): Promise<UpdateReport>
    openRelease(url: string): Promise<boolean>
  }
  /** Subscribe to the event stream. Returns an unsubscribe function. */
  on(handler: (event: AgentEvent) => void): () => void
}

declare global {
  interface Window {
    openbot: OpenBotApi
  }
}
