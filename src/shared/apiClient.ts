/** One typed API surface for Electron preload and the authenticated browser transport. */
import type {
  AgentEvent,
  ActivityItem,
  AgentTask,
  AgentTaskSummary,
  AgentGroup,
  CollaborationRoom,
  AgentMode,
  ApprovalDecision,
  Attachment,
  AppStatus,
  BackendInfo,
  Board,
  Bot,
  BotSaveResult,
  ComputerProbeResult,
  ComputerTarget,
  HumanComputerAction,
  ScreenFrame,
  ScreenControlResult,
  VmAdminResult,
  VmProvisionStatus,
  VmProvisionResult,
  MemoryEntry,
  Message,
  OpenBotApi,
  Project,
  ProjectSummary,
  Routine,
  Session,
  SessionSummary,
  Settings,
  SearchResult,
  Skill,
  SkillInstallResult,
  SkillUninstallResult,
  UpdateReport
} from './types'


export interface ApiTransport {
  invoke<T>(channel: string, ...args: unknown[]): Promise<T>
  subscribe<T>(channel: string, listener: (payload: T) => void): () => void
}
const EVENT_CHANNEL = 'openbot:event'
export function createOpenBotApi(transport: ApiTransport, environment: OpenBotApi['environment'] = { kind: 'desktop' }): OpenBotApi {
const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => transport.invoke<T>(channel, ...args)
// A notification can activate a newly created window before React has booted.
const notificationListeners = new Set<(target: import('./desktopNotifications').NotificationTarget) => void>()
let pendingNotification: import('./desktopNotifications').NotificationTarget | null = null
transport.subscribe<import('./desktopNotifications').NotificationTarget>('openbot:notification:open', target => {
  if (!notificationListeners.size) pendingNotification = target
  else for (const listener of notificationListeners) listener(target)
})

const api: OpenBotApi = {
  environment,
  notifications: {
    status: () => invoke('openbot:notification:status'),
    test: () => invoke('openbot:notification:test'),
    openSettings: () => invoke('openbot:notification:settings'),
    onOpen: (listener) => {
      notificationListeners.add(listener)
      if (pendingNotification) {
        const target = pendingNotification; pendingNotification = null
        queueMicrotask(() => { if (notificationListeners.has(listener)) listener(target) })
      }
      return () => { notificationListeners.delete(listener) }
    }
  },
  voice: {
    saveLanguage: (language) => invoke('openbot:voice:language', language),
    status: (language) => invoke('openbot:voice:status', language),
    start: (id, language) => invoke('openbot:voice:start', id, language),
    stop: (id, cancel) => invoke('openbot:voice:stop', id, cancel),
    on: (listener) => {
      return transport.subscribe<import('./voice').VoiceEvent>('openbot:voice:event', listener)
    }
  },
  sendRules: {
    list: () => invoke('openbot:send-rules:list'),
    saveFromGmailDraft: (draftId, sessionId) => invoke('openbot:send-rules:save-gmail-draft', draftId, sessionId),
    remove: (id) => invoke('openbot:send-rules:remove', id)
  },
  slackDrafts: {
    list: (sessionId) => invoke('openbot:slack-drafts:list', sessionId),
    act: (id, sessionId, action) => invoke('openbot:slack-drafts:act', id, sessionId, action)
  },
  gmailDrafts: {
    presented: (id, sessionId, updatedAt) => invoke('openbot:gmail-drafts:presented', id, sessionId, updatedAt),
    list: (sessionId) => invoke('openbot:gmail-drafts:list', sessionId),
    act: (id, sessionId, action) => invoke('openbot:gmail-drafts:act', id, sessionId, action)
  },
  calendarDrafts: {
    list: (sessionId) => invoke('openbot:calendar-drafts:list', sessionId),
    act: (id, sessionId, action) => invoke('openbot:calendar-drafts:act', id, sessionId, action)
  },
  xDrafts: {
    list: (sessionId) => invoke('openbot:x-drafts:list', sessionId),
    act: (id, sessionId, action) => invoke('openbot:x-drafts:act', id, sessionId, action)
  },
  githubDrafts: {
    list: (sessionId) => invoke('openbot:github-drafts:list', sessionId),
    act: (id, sessionId, action) => invoke('openbot:github-drafts:act', id, sessionId, action)
  },
  vault: {
    update: (id, input) => invoke('openbot:vault:update', id, input),
    list: () => invoke('openbot:vault:list'),
    add: (input) => invoke('openbot:vault:add', input),
    remove: (id) => invoke('openbot:vault:remove', id),
    fill: (botId, sessionId, id, field) => invoke('openbot:vault:fill', botId, sessionId, id, field)
  },
  search: {
    query: (text, limit) => invoke<SearchResult[]>('openbot:search:query', text, limit)
  },
  activity: {
    list: () => invoke<ActivityItem[]>('openbot:activity:list'),
    markRead: (id) => invoke<void>('openbot:activity:markRead', id),
    clear: () => invoke<void>('openbot:activity:clear')
  },
  tasks: {
    clarifications: (taskId) => invoke('openbot:tasks:clarifications', taskId),
    cancelClarification: (id) => invoke('openbot:tasks:cancelClarification', id),
    answerClarification: (id, answers) => invoke('openbot:tasks:answerClarification', id, answers),
    list: () => invoke<AgentTask[]>('openbot:tasks:list'),
    summaries: (botId) => invoke<AgentTaskSummary[]>('openbot:tasks:summaries', botId),
    get: (id) => invoke<AgentTask | null>('openbot:tasks:get', id),
    create: (botId, prompt, title) => invoke<AgentTask | null>('openbot:tasks:create', botId, prompt, title),
    cancel: (id) => invoke<AgentTask | null>('openbot:tasks:cancel', id)
  },
  groups: {
    list: () => invoke<AgentGroup[]>('openbot:groups:list'),
    create: (name) => invoke<AgentGroup>('openbot:groups:create', name),
    update: (id, patch) => invoke<AgentGroup | null>('openbot:groups:update', id, patch),
    remove: (id) => invoke<void>('openbot:groups:remove', id)
  },
  rooms: {
    devices: (roomId) => invoke('openbot:rooms:devices', roomId),
    decideDevice: (roomId, deviceId, action, permission, scope) => invoke('openbot:rooms:decideDevice', roomId, deviceId, action, permission, scope),
    list: () => invoke<CollaborationRoom[]>('openbot:rooms:list'),
    create: (sessionId, name, permission) => invoke<CollaborationRoom | null>('openbot:rooms:create', sessionId, name, permission),
    remove: (id) => invoke<boolean>('openbot:rooms:remove', id),
    qr: (id) => invoke<string | null>('openbot:rooms:qr', id)
  },
  sessions: {
    watch: (slot, id) => invoke<void>('openbot:sessions:watch', slot, id),
    list: () => invoke<SessionSummary[]>('openbot:sessions:list'),
    get: (id) => invoke<Session | null>('openbot:sessions:get', id),
    attachment: (sessionId, messageId, attachmentId) => invoke<string | null>('openbot:sessions:attachment', sessionId, messageId, attachmentId),
    create: (botIds) => invoke<Session>('openbot:sessions:create', botIds),
    clear: (id) => invoke<Session | null>('openbot:sessions:clear', id),
    archiveAndClear: (id) => invoke<Session | null>('openbot:sessions:archiveAndClear', id),
    rename: (id, title) => invoke<void>('openbot:sessions:rename', id, title),
    archive: (id) => invoke<void>('openbot:sessions:archive', id),
    unarchive: (id) => invoke<void>('openbot:sessions:unarchive', id),
    remove: (id) => invoke<void>('openbot:sessions:remove', id),
    setMode: (id, mode: AgentMode) => invoke<void>('openbot:sessions:setMode', id, mode),
    addBot: (id, botId) => invoke<void>('openbot:sessions:addBot', id, botId),
    removeBot: (id, botId) => invoke<void>('openbot:sessions:removeBot', id, botId),
    setActiveBot: (id, botId) => invoke<void>('openbot:sessions:setActiveBot', id, botId),
    setCwd: (id, cwd) => invoke<void>('openbot:sessions:setCwd', id, cwd),
    setProject: (id, projectId) => invoke<void>('openbot:sessions:setProject', id, projectId),
    react: (id, messageId, emoji, actor) => invoke<void>('openbot:sessions:react', id, messageId, emoji, actor)
  },

  projects: {
    list: () => invoke<ProjectSummary[]>('openbot:projects:list'),
    get: (id) => invoke<Project | null>('openbot:projects:get', id),
    create: (partial) => invoke<Project>('openbot:projects:create', partial),
    update: (id, patch) => invoke<Project>('openbot:projects:update', id, patch),
    remove: (id) => invoke<void>('openbot:projects:remove', id),
    board: (id) => invoke<Board | null>('openbot:projects:board', id),
    addCard: (projectId, columnId, card) =>
      invoke<Board | null>('openbot:projects:addCard', projectId, columnId, card),
    updateCard: (projectId, cardId, patch) =>
      invoke<Board | null>('openbot:projects:updateCard', projectId, cardId, patch),
    moveCard: (projectId, cardId, toColumnId, toIndex) =>
      invoke<Board | null>('openbot:projects:moveCard', projectId, cardId, toColumnId, toIndex),
    removeCard: (projectId, cardId) =>
      invoke<Board | null>('openbot:projects:removeCard', projectId, cardId),
    addColumn: (projectId, name) =>
      invoke<Board | null>('openbot:projects:addColumn', projectId, name),
    renameColumn: (projectId, columnId, name) =>
      invoke<Board | null>('openbot:projects:renameColumn', projectId, columnId, name),
    setColumnDone: (projectId, columnId, done) =>
      invoke<Board | null>('openbot:projects:setColumnDone', projectId, columnId, done),
    removeColumn: (projectId, columnId) =>
      invoke<Board | null>('openbot:projects:removeColumn', projectId, columnId)
  },

  bots: {
    list: () => invoke<Bot[]>('openbot:bots:list'),
    get: (id) => invoke<Bot | null>('openbot:bots:get', id),
    create: (partial) => invoke<BotSaveResult>('openbot:bots:create', partial),
    update: (id, patch) => invoke<BotSaveResult>('openbot:bots:update', id, patch),
    duplicate: (id) => invoke<BotSaveResult>('openbot:bots:duplicate', id),
    probeTarget: (target: ComputerTarget, botId?: string) =>
      invoke<ComputerProbeResult>('openbot:bots:probeTarget', target, botId),
    provisionTarget: () => invoke<VmProvisionResult>('openbot:bots:provisionTarget'),
    provisionStatus: () => invoke<VmProvisionStatus>('openbot:bots:provisionStatus'),
    cancelProvision: () => invoke<VmProvisionStatus>('openbot:bots:cancelProvision'),
    captureScreen: (id, sessionId) => invoke<ScreenControlResult>('openbot:bots:captureScreen', id, sessionId),
    controlScreen: (id, action: HumanComputerAction, sessionId) =>
      invoke<ScreenControlResult>('openbot:bots:controlScreen', id, action, sessionId),
    browserScope: (id) => invoke<{ mode: 'legacy' | 'session' } | { error: string }>('openbot:bots:browserScope', id),
    openResource: (id, sessionId, kind) => invoke<{ ok: boolean; error?: string; spaceId?: number }>('openbot:bots:openResource', id, sessionId, kind),
    restartTarget: (id) => invoke<ComputerProbeResult>('openbot:bots:restartTarget', id),
    runAdminCommand: (id, command) =>
      invoke<VmAdminResult>('openbot:bots:runAdminCommand', id, command),
    discardTarget: (target: ComputerTarget) => invoke<void>('openbot:bots:discardTarget', target),
    remove: (id) => invoke<{ ok: true } | { ok: false; error: string }>('openbot:bots:remove', id),
    memory: (id) => invoke<MemoryEntry[]>('openbot:bots:memory', id),
    addMemory: (id, text) => invoke<MemoryEntry | null>('openbot:bots:addMemory', id, text),
    removeMemory: (id, entryId) => invoke<boolean>('openbot:bots:removeMemory', id, entryId)
  },

  routines: {
    createInstruction: (botId, name, instruction, trigger, notifyPolicy) => invoke<Routine | null>('openbot:routines:createInstruction', botId, name, instruction, trigger, notifyPolicy),
    webhookSetup: (id) => invoke('openbot:routines:webhookSetup', id),
    backgroundStatus: () => invoke('openbot:routines:backgroundStatus'),
    list: (botId) => invoke<Routine[]>('openbot:routines:list', botId),
    get: (id) => invoke<Routine | null>('openbot:routines:get', id),
    update: (id, patch) => invoke<Routine | null>('openbot:routines:update', id, patch),
    remove: (id) => invoke<void>('openbot:routines:remove', id),
    run: (id, sessionId) => invoke<boolean>('openbot:routines:run', id, sessionId),
    startRecording: (botId, name) =>
      invoke<void>('openbot:routines:startRecording', botId, name),
    stopRecording: () => invoke<Routine | null>('openbot:routines:stopRecording')
  },

  agent: {
    liveMessages: (sessionId) => invoke<Message[]>('openbot:agent:liveMessages', sessionId),
    isRunning: (sessionId) => invoke<boolean>('openbot:agent:isRunning', sessionId),
    steer: (sessionId, text) => invoke<boolean>('openbot:agent:steer', sessionId, text),
    queue: (sessionId) => invoke('openbot:agent:queue', sessionId),
    enqueue: (sessionId, text, attachments) => invoke('openbot:agent:enqueue', sessionId, text, attachments),
    pauseQueue: (sessionId, paused) => invoke('openbot:agent:pauseQueue', sessionId, paused),
    removeQueued: (sessionId, id) => invoke('openbot:agent:removeQueued', sessionId, id),
    send: (sessionId, text, attachments?: Attachment[]) =>
      invoke<boolean>('openbot:agent:send', sessionId, text, attachments),
    stop: (sessionId, message) => invoke<boolean>('openbot:agent:stop', sessionId, message),
    respondToApproval: (requestId, decision: ApprovalDecision) =>
      invoke<void>('openbot:agent:respondToApproval', requestId, decision),
    returnControl: (requestId) => invoke<boolean>('openbot:agent:returnControl', requestId)
  },

  backends: {
    list: () => invoke<BackendInfo[]>('openbot:backends:list'),
    refresh: () => invoke<BackendInfo[]>('openbot:backends:refresh'),
    recheck: (id: string) => invoke<BackendInfo[]>('openbot:backends:recheck', id),
    login: (id: string) => invoke<{ started: boolean }>('openbot:backends:login', id)
  },

  apps: {
    status: () => invoke<AppStatus[]>('openbot:apps:status'),
    connectGitHub: (botId) => invoke<{ started: boolean; error?: string }>('openbot:apps:connectGitHub', botId),
    setBotAccess: (service, botId, enabled) => invoke('openbot:apps:setBotAccess', service, botId, enabled),
    disconnectGitHub: () => invoke<{ ok: boolean }>('openbot:apps:disconnectGitHub'),
    connectGit: (name, email) => invoke<AppStatus>('openbot:apps:connectGit', name, email),
    requestGmail: () => invoke<AppStatus>('openbot:apps:requestGmail'),
    connectGoogle: (service, clientId, clientSecret, options) => invoke<{ ok: boolean; error?: string }>('openbot:apps:connectGoogle', service, clientId, clientSecret, options),
    cancelGoogle: () => invoke<void>('openbot:apps:cancelGoogle'),
    disconnectGoogle: (service, accountId) => invoke<{ ok: boolean }>('openbot:apps:disconnectGoogle', service, accountId),
    connectX: (clientId, botId) => invoke<{ ok: boolean; error?: string }>('openbot:apps:connectX', clientId, botId),
    cancelX: () => invoke<void>('openbot:apps:cancelX'),
    disconnectX: () => invoke<{ ok: boolean }>('openbot:apps:disconnectX'),
    slackStatus: () => invoke('openbot:apps:slackStatus'),
    connectSlack: (input) => invoke<{ ok: boolean }>('openbot:apps:connectSlack', input),
    disconnectSlack: () => invoke<{ ok: boolean }>('openbot:apps:disconnectSlack')
  },

  skills: {
    list: (cwd) => invoke<Skill[]>('openbot:skills:list', cwd),
    refresh: (cwd) => invoke<Skill[]>('openbot:skills:refresh', cwd),
    forBackend: (backendId, cwd) => invoke<Skill[]>('openbot:skills:for', backendId, cwd),
    install: (sourcePath, opts) =>
      invoke<SkillInstallResult>('openbot:skills:install', sourcePath, opts),
    uninstall: (id) => invoke<SkillUninstallResult>('openbot:skills:uninstall', id),
    syncExisting: () => invoke('openbot:skills:syncExisting')
  },
  settings: {
    saveDecisionReview: (enabled) => invoke('openbot:settings:decisionReview', enabled),
    saveMcpServer: (edit) => invoke<import('./settings').McpServerSaveResult>('openbot:settings:saveMcpServer', edit),
    editPermission: (edit) => invoke('openbot:settings:editPermission', edit),
    saveProfile: (patch) => invoke<import('./settings').UserProfileSaveResult>('openbot:settings:saveProfile', patch),
    get: () => invoke<Settings>('openbot:settings:get'),
    update: (patch) => invoke<Settings>('openbot:settings:update', patch)
  },

  dialog: {
    pickDirectory: () => invoke<string | null>('openbot:dialog:pickDirectory'),
    pickFiles: () => invoke<string[]>('openbot:dialog:pickFiles')
  },

  window: {
    chromeStatus: () => invoke('openbot:window:chromeStatus'),
    chromeLayout: width => invoke('openbot:window:chromeLayout', width),
    onChromeChanged: listener => transport.subscribe('openbot:window:chromeChanged', listener),
    setFullScreen: (active) => invoke<boolean>('openbot:window:setFullScreen', active),
    isFullScreen: () => invoke<boolean>('openbot:window:isFullScreen')
  },

  updates: {
    version: () => invoke<string>('openbot:app:version'),
    check: (channel) => invoke<UpdateReport>('openbot:app:checkUpdate', channel),
    openRelease: (url) => invoke<boolean>('openbot:app:openRelease', url)
  },

  /** Subscribe to the main -> renderer event stream; returns an unsubscribe. */
  on: (handler: (event: AgentEvent) => void) => transport.subscribe<AgentEvent>(EVENT_CHANNEL, payload => {
    try { handler(payload) } catch (error) { console.error('[openbot] event handler threw', error) }
  })
}
return api
}
