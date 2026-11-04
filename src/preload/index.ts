/**
 * The context bridge. This is the entire surface the renderer gets:
 * `window.openbot`, shaped exactly like `OpenBotApi`. No `ipcRenderer`, no
 * `require`, no Node built-ins leak past this file.
 *
 * Channel names are duplicated from `src/main/ipc/channels.ts` on purpose —
 * importing that module would drag the main-process bundle in here. Keep the
 * two lists in step.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AgentEvent,
  ActivityItem,
  AgentTask,
  AgentGroup,
  CollaborationRoom,
  AgentMode,
  ApprovalDecision,
  Attachment,
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
} from '../shared/types'

const EVENT_CHANNEL = 'openbot:event'
const MENU_CHANNEL = 'openbot:menu'

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>
}

const api: OpenBotApi = {
  search: {
    query: (text, limit) => invoke<SearchResult[]>('openbot:search:query', text, limit)
  },
  activity: {
    list: () => invoke<ActivityItem[]>('openbot:activity:list'),
    markRead: (id) => invoke<void>('openbot:activity:markRead', id),
    clear: () => invoke<void>('openbot:activity:clear')
  },
  tasks: {
    list: () => invoke<AgentTask[]>('openbot:tasks:list'),
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
    list: () => invoke<CollaborationRoom[]>('openbot:rooms:list'),
    create: (sessionId, name) => invoke<CollaborationRoom | null>('openbot:rooms:create', sessionId, name),
    remove: (id) => invoke<void>('openbot:rooms:remove', id)
  },
  sessions: {
    list: () => invoke<SessionSummary[]>('openbot:sessions:list'),
    get: (id) => invoke<Session | null>('openbot:sessions:get', id),
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
    captureScreen: (id) => invoke<ScreenControlResult>('openbot:bots:captureScreen', id),
    controlScreen: (id, action: HumanComputerAction) =>
      invoke<ScreenControlResult>('openbot:bots:controlScreen', id, action),
    restartTarget: (id) => invoke<ComputerProbeResult>('openbot:bots:restartTarget', id),
    runAdminCommand: (id, command) =>
      invoke<VmAdminResult>('openbot:bots:runAdminCommand', id, command),
    discardTarget: (target: ComputerTarget) => invoke<void>('openbot:bots:discardTarget', target),
    remove: (id) => invoke<void>('openbot:bots:remove', id),
    memory: (id) => invoke<MemoryEntry[]>('openbot:bots:memory', id),
    addMemory: (id, text) => invoke<MemoryEntry>('openbot:bots:addMemory', id, text),
    removeMemory: (id, entryId) => invoke<void>('openbot:bots:removeMemory', id, entryId)
  },

  routines: {
    list: (botId) => invoke<Routine[]>('openbot:routines:list', botId),
    get: (id) => invoke<Routine | null>('openbot:routines:get', id),
    update: (id, patch) => invoke<Routine>('openbot:routines:update', id, patch),
    remove: (id) => invoke<void>('openbot:routines:remove', id),
    run: (id, sessionId) => invoke<void>('openbot:routines:run', id, sessionId),
    startRecording: (botId, name) =>
      invoke<void>('openbot:routines:startRecording', botId, name),
    stopRecording: () => invoke<Routine | null>('openbot:routines:stopRecording')
  },

  agent: {
    send: (sessionId, text, attachments?: Attachment[]) =>
      invoke<void>('openbot:agent:send', sessionId, text, attachments),
    stop: (sessionId) => invoke<void>('openbot:agent:stop', sessionId),
    respondToApproval: (requestId, decision: ApprovalDecision) =>
      invoke<void>('openbot:agent:respondToApproval', requestId, decision),
    returnControl: (requestId) => invoke<boolean>('openbot:agent:returnControl', requestId)
  },

  backends: {
    list: () => invoke<BackendInfo[]>('openbot:backends:list'),
    refresh: () => invoke<BackendInfo[]>('openbot:backends:refresh')
  },

  skills: {
    list: (cwd) => invoke<Skill[]>('openbot:skills:list', cwd),
    refresh: (cwd) => invoke<Skill[]>('openbot:skills:refresh', cwd),
    forBackend: (backendId, cwd) => invoke<Skill[]>('openbot:skills:for', backendId, cwd),
    install: (sourcePath, opts) =>
      invoke<SkillInstallResult>('openbot:skills:install', sourcePath, opts),
    uninstall: (id) => invoke<SkillUninstallResult>('openbot:skills:uninstall', id)
  },
  settings: {
    get: () => invoke<Settings>('openbot:settings:get'),
    update: (patch) => invoke<Settings>('openbot:settings:update', patch)
  },

  dialog: {
    pickDirectory: () => invoke<string | null>('openbot:dialog:pickDirectory'),
    pickFiles: () => invoke<string[]>('openbot:dialog:pickFiles')
  },

  window: {
    setFullScreen: (active) => invoke<boolean>('openbot:window:setFullScreen', active),
    isFullScreen: () => invoke<boolean>('openbot:window:isFullScreen')
  },

  updates: {
    version: () => invoke<string>('openbot:app:version'),
    check: (channel) => invoke<UpdateReport>('openbot:app:checkUpdate', channel),
    openRelease: (url) => invoke<boolean>('openbot:app:openRelease', url)
  },

  /** Subscribe to the main -> renderer event stream; returns an unsubscribe. */
  on: (handler: (event: AgentEvent) => void) => {
    const listener = (_event: IpcRendererEvent, payload: AgentEvent): void => {
      try {
        handler(payload)
      } catch (err) {
        console.error('[openbot] event handler threw', err)
      }
    }
    ipcRenderer.on(EVENT_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(EVENT_CHANNEL, listener)
    }
  }
}

contextBridge.exposeInMainWorld('openbot', api)

/**
 * Native-menu commands reach the renderer as DOM events rather than as extra
 * bridge surface: `openbot:menu:new-chat` and `openbot:menu:settings` fire on
 * `window`, and the same command also arrives as a `postMessage` payload
 * `{ source: 'openbot', type: 'menu', command }` for listeners that prefer it.
 */
ipcRenderer.on(MENU_CHANNEL, (_event: IpcRendererEvent, command: unknown) => {
  if (typeof command !== 'string') return
  try {
    window.dispatchEvent(new Event(`openbot:menu:${command}`))
    window.postMessage({ source: 'openbot', type: 'menu', command }, '*')
  } catch (err) {
    console.error('[openbot] could not deliver menu command', err)
  }
})
