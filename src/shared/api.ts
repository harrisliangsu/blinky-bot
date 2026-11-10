/** The IPC surface exposed to the renderer as `window.openbot`. */

import type { Attachment, Message } from './chat'
import type { MessageQueue } from './messageQueue'
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
import type { ActivityItem, AgentTask, AgentTaskSummary } from './activity'
import type { CollaborationRoom } from './rooms'

export interface OpenBotApi {
  environment?: { kind: 'desktop' | 'browser'; scope?: 'room' | 'workspace'; permission?: 'view' | 'control'; capabilities?: string[]; initialSessionId?: string }
  history?: { hasMore(sessionId: string): boolean; loadEarlier(sessionId: string, beforeApply?: () => void): Promise<void>; subscribe(listener: () => void): () => void }
  notifications: {
    status(): Promise<import('./desktopNotifications').NotificationStatus>
    test(): Promise<boolean>
    openSettings(): Promise<void>
    onOpen(listener: (target: import('./desktopNotifications').NotificationTarget) => void): () => void
  }
  voice: {
    saveLanguage: (language: string) => Promise<import('./voice').VoiceLanguageSaveResult>
    status(language: string): Promise<import('./voice').VoiceStatus>
    start(id: string, language: string): Promise<import('./voice').VoiceReply>
    stop(id: string, cancel?: boolean): Promise<void>
    on(listener: (event: import('./voice').VoiceEvent) => void): () => void
  }
  sendRules: {
    list(): Promise<{ ok: boolean; rules?: import('./sendRules').GmailSendRule[]; error?: string }>
    saveFromGmailDraft(draftId: string, sessionId: string): Promise<{ ok: boolean; rule?: import('./sendRules').GmailSendRule; error?: string }>
    remove(id: string): Promise<{ ok: boolean; error?: string }>
  }
  slackDrafts: {
    list(sessionId: string): Promise<{ ok: boolean; drafts?: import('./drafts').SlackDraft[]; error?: string }>
    act(id: string, sessionId: string, action: 'send' | 'cancel'): Promise<{ ok: boolean; draft?: import('./drafts').SlackDraft; error?: string }>
  }
  gmailDrafts: {
    list(sessionId: string): Promise<{ ok: boolean; drafts?: import('./drafts').GmailDraft[]; error?: string }>
    presented(id: string, sessionId: string, updatedAt: number): Promise<boolean>
    act(id: string, sessionId: string, action: 'send' | 'cancel'): Promise<{ ok: boolean; draft?: import('./drafts').GmailDraft; error?: string }>
  }
  calendarDrafts: {
    list(sessionId: string): Promise<{ ok: boolean; drafts?: import('./drafts').CalendarDraft[]; error?: string }>
    act(id: string, sessionId: string, action: 'send' | 'cancel'): Promise<{ ok: boolean; draft?: import('./drafts').CalendarDraft; error?: string }>
  }
  xDrafts: {
    list(sessionId: string): Promise<{ ok: boolean; drafts?: import('./drafts').XDraft[]; error?: string }>
    act(id: string, sessionId: string, action: 'send' | 'cancel'): Promise<{ ok: boolean; draft?: import('./drafts').XDraft; error?: string }>
  }
  githubDrafts: {
    list(sessionId: string): Promise<{ ok: boolean; drafts?: import('./drafts').GitHubCommentDraft[]; error?: string }>
    act(id: string, sessionId: string, action: 'send' | 'cancel'): Promise<{ ok: boolean; draft?: import('./drafts').GitHubCommentDraft; error?: string }>
  }
  vault: {
    update(id: string, input: import('./vault').VaultUpdate): Promise<import('./vault').VaultResult<import('./vault').VaultItem>>
    list(): Promise<import('./vault').VaultResult<import('./vault').VaultItem[]>>
    add(input: import('./vault').VaultInput): Promise<import('./vault').VaultResult<import('./vault').VaultItem>>
    remove(id: string): Promise<import('./vault').VaultResult<boolean>>
    fill(botId: string, sessionId: string, id: string, field: string): Promise<import('./vault').VaultResult<boolean>>
  }
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
    clarifications(taskId?: string): Promise<import('./activity').AgentTaskClarification[]>
    cancelClarification(id: string): Promise<{ ok: true; request: import('./activity').AgentTaskClarification } | { ok: false; error: string }>
    answerClarification(id: string, answers: Record<string, string[]>): Promise<{ ok: true; request: import('./activity').AgentTaskClarification } | { ok: false; error: string }>
    list(): Promise<AgentTask[]>
    summaries(botId?: string): Promise<AgentTaskSummary[]>
    get(id: string): Promise<AgentTask | null>
    create(botId: string, prompt: string, title?: string): Promise<AgentTask | null>
    cancel(id: string): Promise<AgentTask | null>
  }
  rooms: {
    devices(roomId: string): Promise<import('./remoteAuth').RemoteDevice[]>
    decideDevice(roomId: string, deviceId: string, action: 'approve' | 'deny' | 'revoke' | 'remove', permission?: 'view' | 'control', scope?: 'room' | 'workspace'): Promise<boolean>
    list(): Promise<CollaborationRoom[]>
    create(sessionId: string, name?: string, permission?: 'view' | 'control'): Promise<CollaborationRoom | null>
    remove(id: string): Promise<boolean>
    qr(id: string): Promise<string | null>
  }
  sessions: {
    watch(slot: 'chat' | 'agent', id: string | null): Promise<void>
    list(): Promise<SessionSummary[]>
    get(id: string): Promise<Session | null>
    attachment(sessionId: string, messageId: string, attachmentId: string): Promise<string | null>
    create(botIds?: string[]): Promise<Session>
    /** Drop messages and CLI resume ids. The bot, its memory and the folder stay. */
    clear(id: string): Promise<Session | null>
    /** Archive this chat, then open an empty one with the same bot and folder. */
    archiveAndClear(id: string): Promise<Session | null>
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
    captureScreen(id: string, sessionId?: string): Promise<ScreenControlResult>
    controlScreen(id: string, action: HumanComputerAction, sessionId?: string): Promise<ScreenControlResult>
    browserScope(id: string): Promise<{ mode: 'legacy' | 'session' } | { error: string }>
    /** Open this conversation's working folder or its owned Ego Space. */
    openResource(id: string, sessionId: string, kind: 'computer' | 'browser'): Promise<{ ok: boolean; error?: string; spaceId?: number }>
    /** Restart an OpenBOT-owned VM without deleting its files or browser profile. */
    restartTarget(id: string): Promise<ComputerProbeResult>
    /** Run a human-entered command as root inside an OpenBOT-owned VM. */
    runAdminCommand(id: string, command: string): Promise<VmAdminResult>
    /** Destroy a managed VM created for a draft that was not saved. */
    discardTarget(target: ComputerTarget): Promise<void>
    remove(id: string): Promise<{ ok: true } | { ok: false; error: string }>
    memory(id: string): Promise<MemoryEntry[]>
    addMemory(id: string, text: string | { text: string; replaceEntryId?: string; requestId?: string; shared?: boolean; kind?: 'profile' | 'journal' | 'note' }): Promise<MemoryEntry | null>
    removeMemory(id: string, entryId: string): Promise<boolean>
  }
  groups: {
    list(): Promise<AgentGroup[]>
    create(name: string): Promise<AgentGroup>
    update(id: string, patch: Partial<AgentGroup>): Promise<AgentGroup | null>
    remove(id: string): Promise<void>
  }
  routines: {
    createInstruction(botId: string, name: string, instruction: string, trigger: Routine['trigger'], notifyPolicy?: Routine['notifyPolicy']): Promise<Routine | null>
    webhookSetup(id: string): Promise<{ url: string; secret: string; state: 'inactive' | 'listening' | 'error' } | null>
    backgroundStatus(): Promise<{ state: 'inactive' | 'active' | 'error' | 'unavailable'; error?: string }>
    list(botId?: string): Promise<Routine[]>
    get(id: string): Promise<Routine | null>
    /** Rename, re-describe, or switch replay mode after recording. */
    update(id: string, patch: Partial<Routine>): Promise<Routine | null>
    remove(id: string): Promise<void>
    run(id: string, sessionId: string): Promise<boolean>
    startRecording(botId: string, name: string): Promise<void>
    stopRecording(): Promise<Routine | null>
  }
  agent: {
    liveMessages(sessionId: string): Promise<Message[]>
    queue(sessionId: string): Promise<MessageQueue | null>
    enqueue(sessionId: string, text: string, attachments?: Attachment[]): Promise<MessageQueue | null>
    pauseQueue(sessionId: string, paused: boolean): Promise<MessageQueue | null>
    removeQueued(sessionId: string, id: string): Promise<MessageQueue | null>
    /** Resolves on acceptance; completion arrives through agent events. */
    send(sessionId: string, text: string, attachments?: Attachment[]): Promise<boolean>
    isRunning(sessionId: string): Promise<boolean>
    /** Feed text into the current Codex turn when it supports steering. */
    steer(sessionId: string, text: string): Promise<boolean>
    stop(sessionId: string, message?: string): Promise<boolean>
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
    connectGitHub(clientId: string, clientSecret: string, botId?: string): Promise<{ ok: boolean; error?: string }>
    cancelGitHub(): Promise<void>
    setBotAccess(service: import('./connectedAppTools').ConnectedApp, botId: string, enabled: boolean): Promise<{ ok: boolean; error?: string; bot?: Bot }>
    disconnectGitHub(): Promise<{ ok: boolean }>
    connectGit(name: string, email: string): Promise<AppStatus>
    requestGmail(): Promise<AppStatus>
    connectGoogle(service: 'gmail' | 'calendar', clientId: string, clientSecret: string, options?: { addAccount?: boolean; accountId?: string; botId?: string }): Promise<{ ok: boolean; error?: string }>
    cancelGoogle(): Promise<void>
    disconnectGoogle(service: 'gmail' | 'calendar', accountId?: string): Promise<{ ok: boolean }>
    connectX(clientId: string, botId?: string): Promise<{ ok: boolean; error?: string }>
    cancelX(): Promise<void>
    disconnectX(): Promise<{ ok: boolean }>
    slackStatus(): Promise<{ state: 'disconnected' | 'connecting' | 'connected' | 'error'; teamId?: string; channelId?: string; allowedUserId?: string; botId?: string }>
    connectSlack(input: { appToken: string; botToken: string; allowedUserId: string; channelId: string; botId: string; accessBotId?: string }): Promise<{ ok: boolean; error?: string }>
    disconnectSlack(): Promise<{ ok: boolean }>
  }
  skills: {
    /** Everything installed, across every CLI's directory plus the shared one. */
    list(cwd?: string): Promise<Skill[]>
    refresh(cwd?: string): Promise<Skill[]>
    /** Only what this backend's CLI can actually see, deduped by preference. */
    forBackend(backendId: string, cwd?: string): Promise<Skill[]>
    /** Copies a folder into the shared directory and reports per-Agent links. */
    install(sourcePath: string, opts?: SkillInstallOptions): Promise<SkillInstallResult>
    uninstall(id: string): Promise<SkillUninstallResult>
    syncExisting(): Promise<import('./skills').SkillBulkSyncResult>
  }
  settings: {
    saveDecisionReview(enabled: boolean): Promise<import('./settings').PermissionSaveResult>
    saveMcpServer(edit: import('./settings').McpServerEdit): Promise<import('./settings').McpServerSaveResult>
    editPermission(edit: import('./settings').PermissionEdit): Promise<import('./settings').PermissionSaveResult>
    saveProfile(patch: import('./settings').UserProfilePatch): Promise<import('./settings').UserProfileSaveResult>
    get(): Promise<Settings>
    update(patch: Partial<Settings>): Promise<Settings>
  }
  dialog: {
    pickDirectory(): Promise<string | null>
    pickFiles(): Promise<string[]>
    /** Browser-native picker and paste import keep image bytes with the message. */
    pickAttachments?(): Promise<Attachment[]>
    importAttachments?(files: readonly File[]): Promise<Attachment[]>
  }
  window: {
    chromeStatus(): Promise<{ supported: boolean; applied: boolean; reduced: boolean }>
    chromeLayout(width: number): Promise<void>
    onChromeChanged(listener: (status: { supported: boolean; applied: boolean; reduced: boolean }) => void): () => void
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
