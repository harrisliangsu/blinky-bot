/**
 * Every IPC channel name in one place.
 *
 * The preload bridge intentionally duplicates these literals rather than
 * importing this module: pulling a main-process file into the preload bundle
 * would drag `electron`'s main APIs and `node:fs` across with it. Keep the two
 * lists in step.
 */

/** main -> renderer: the `AgentEvent` stream. */
export const EVENT_CHANNEL = 'openbot:event'

/** main -> renderer: native menu commands. */
export const MENU_CHANNEL = 'openbot:menu'

export type MenuCommand = 'new-chat' | 'settings'

export const CHANNELS = {
  searchQuery: 'openbot:search:query',
  activityList: 'openbot:activity:list',
  activityMarkRead: 'openbot:activity:markRead',
  activityClear: 'openbot:activity:clear',
  tasksList: 'openbot:tasks:list',
  tasksCreate: 'openbot:tasks:create',
  tasksCancel: 'openbot:tasks:cancel',
  groupsList: 'openbot:groups:list',
  groupsCreate: 'openbot:groups:create',
  groupsUpdate: 'openbot:groups:update',
  groupsRemove: 'openbot:groups:remove',
  roomsList: 'openbot:rooms:list',
  roomsCreate: 'openbot:rooms:create',
  roomsRemove: 'openbot:rooms:remove',
  sessionsList: 'openbot:sessions:list',
  sessionsGet: 'openbot:sessions:get',
  sessionsCreate: 'openbot:sessions:create',
  sessionsRename: 'openbot:sessions:rename',
  sessionsArchive: 'openbot:sessions:archive',
  sessionsUnarchive: 'openbot:sessions:unarchive',
  sessionsRemove: 'openbot:sessions:remove',
  sessionsSetMode: 'openbot:sessions:setMode',
  sessionsAddBot: 'openbot:sessions:addBot',
  sessionsRemoveBot: 'openbot:sessions:removeBot',
  sessionsSetActiveBot: 'openbot:sessions:setActiveBot',
  sessionsSetCwd: 'openbot:sessions:setCwd',
  sessionsSetProject: 'openbot:sessions:setProject',
  sessionsReact: 'openbot:sessions:react',

  projectsList: 'openbot:projects:list',
  projectsGet: 'openbot:projects:get',
  projectsCreate: 'openbot:projects:create',
  projectsUpdate: 'openbot:projects:update',
  projectsRemove: 'openbot:projects:remove',
  projectsBoard: 'openbot:projects:board',
  projectsAddCard: 'openbot:projects:addCard',
  projectsUpdateCard: 'openbot:projects:updateCard',
  projectsMoveCard: 'openbot:projects:moveCard',
  projectsRemoveCard: 'openbot:projects:removeCard',
  projectsAddColumn: 'openbot:projects:addColumn',
  projectsRenameColumn: 'openbot:projects:renameColumn',
  projectsSetColumnDone: 'openbot:projects:setColumnDone',
  projectsRemoveColumn: 'openbot:projects:removeColumn',

  skillsList: 'openbot:skills:list',
  skillsRefresh: 'openbot:skills:refresh',
  skillsFor: 'openbot:skills:for',
  skillsInstall: 'openbot:skills:install',
  skillsUninstall: 'openbot:skills:uninstall',

  botsList: 'openbot:bots:list',
  botsGet: 'openbot:bots:get',
  botsCreate: 'openbot:bots:create',
  botsUpdate: 'openbot:bots:update',
  botsDuplicate: 'openbot:bots:duplicate',
  botsProbeTarget: 'openbot:bots:probeTarget',
  botsProvisionTarget: 'openbot:bots:provisionTarget',
  botsProvisionStatus: 'openbot:bots:provisionStatus',
  botsCancelProvision: 'openbot:bots:cancelProvision',
  botsCaptureScreen: 'openbot:bots:captureScreen',
  botsControlScreen: 'openbot:bots:controlScreen',
  botsRestartTarget: 'openbot:bots:restartTarget',
  botsRunAdminCommand: 'openbot:bots:runAdminCommand',
  botsDiscardTarget: 'openbot:bots:discardTarget',
  botsRemove: 'openbot:bots:remove',
  botsMemory: 'openbot:bots:memory',
  botsAddMemory: 'openbot:bots:addMemory',
  botsRemoveMemory: 'openbot:bots:removeMemory',

  routinesList: 'openbot:routines:list',
  routinesGet: 'openbot:routines:get',
  routinesUpdate: 'openbot:routines:update',
  routinesRemove: 'openbot:routines:remove',
  routinesRun: 'openbot:routines:run',
  routinesStartRecording: 'openbot:routines:startRecording',
  routinesStopRecording: 'openbot:routines:stopRecording',

  agentSend: 'openbot:agent:send',
  agentStop: 'openbot:agent:stop',
  agentRespondToApproval: 'openbot:agent:respondToApproval',
  agentReturnControl: 'openbot:agent:returnControl',

  backendsList: 'openbot:backends:list',
  backendsRefresh: 'openbot:backends:refresh',
  backendsRecheck: 'openbot:backends:recheck',
  backendsLogin: 'openbot:backends:login',

  settingsGet: 'openbot:settings:get',
  settingsUpdate: 'openbot:settings:update',

  dialogPickDirectory: 'openbot:dialog:pickDirectory',
  dialogPickFiles: 'openbot:dialog:pickFiles',

  windowSetFullScreen: 'openbot:window:setFullScreen',
  windowIsFullScreen: 'openbot:window:isFullScreen',

  appVersion: 'openbot:app:version',
  appCheckUpdate: 'openbot:app:checkUpdate',
  appOpenRelease: 'openbot:app:openRelease'
} as const
