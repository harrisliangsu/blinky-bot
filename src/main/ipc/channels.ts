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

export type MenuCommand = 'new-chat' | 'archive-clear' | 'settings' | 'focus-composer' | 'find-bot' | 'toggle-sidebar'

export const CHANNELS = {
  searchQuery: 'openbot:search:query',
  activityList: 'openbot:activity:list',
  activityMarkRead: 'openbot:activity:markRead',
  activityClear: 'openbot:activity:clear',
  tasksList: 'openbot:tasks:list',
  tasksClarifications: 'openbot:tasks:clarifications',
  tasksAnswerClarification: 'openbot:tasks:answerClarification',
  tasksCancelClarification: 'openbot:tasks:cancelClarification',
  tasksSummaries: 'openbot:tasks:summaries',
  tasksGet: 'openbot:tasks:get',
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
  sessionsWatch: 'openbot:sessions:watch',
  sessionsGet: 'openbot:sessions:get',
  sessionsAttachment: 'openbot:sessions:attachment',
  sessionsCreate: 'openbot:sessions:create',
  sessionsClear: 'openbot:sessions:clear',
  sessionsArchiveAndClear: 'openbot:sessions:archiveAndClear',
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
  skillsSyncExisting: 'openbot:skills:syncExisting',

  agentsMdList: 'openbot:agents-md:list',
  agentsMdRead: 'openbot:agents-md:read',
  agentsMdCreate: 'openbot:agents-md:create',
  agentsMdWrite: 'openbot:agents-md:write',

  systemPermissionsStatus: 'openbot:system-permissions:status',
  systemPermissionsOpen: 'openbot:system-permissions:open',

  botsList: 'openbot:bots:list',
  botsGet: 'openbot:bots:get',
  botsCreate: 'openbot:bots:create',
  botsUpdate: 'openbot:bots:update',
  botsDuplicate: 'openbot:bots:duplicate',
  botsProbeTarget: 'openbot:bots:probeTarget',
  botsBrowserScope: 'openbot:bots:browserScope',
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
  agentLiveMessages: 'openbot:agent:liveMessages',
  agentReturnControl: 'openbot:agent:returnControl',

  backendsList: 'openbot:backends:list',
  backendsRefresh: 'openbot:backends:refresh',
  backendsRecheck: 'openbot:backends:recheck',
  backendsLogin: 'openbot:backends:login',

  appsStatus: 'openbot:apps:status',
  appsConnectGitHub: 'openbot:apps:connectGitHub',
  appsCancelGitHub: 'openbot:apps:cancelGitHub',
  appsDisconnectGitHub: 'openbot:apps:disconnectGitHub',
  appsConnectGit: 'openbot:apps:connectGit',
  appsRequestGmail: 'openbot:apps:requestGmail',
  appsConnectGoogle: 'openbot:apps:connectGoogle',
  appsCancelGoogle: 'openbot:apps:cancelGoogle',
  appsDisconnectGoogle: 'openbot:apps:disconnectGoogle',
  appsConnectX: 'openbot:apps:connectX',
  appsCancelX: 'openbot:apps:cancelX',
  appsDisconnectX: 'openbot:apps:disconnectX',
  appsSlackStatus: 'openbot:apps:slackStatus',
  appsConnectSlack: 'openbot:apps:connectSlack',
  appsDisconnectSlack: 'openbot:apps:disconnectSlack',

  settingsSaveMcpServer: 'openbot:settings:saveMcpServer',
  settingsGet: 'openbot:settings:get',
  settingsEditPermission: 'openbot:settings:editPermission',
  settingsSaveProfile: 'openbot:settings:saveProfile',
  settingsUpdate: 'openbot:settings:update',
  settingsSaveDecisionReview: 'openbot:settings:decisionReview',

  dialogPickDirectory: 'openbot:dialog:pickDirectory',
  dialogPickFiles: 'openbot:dialog:pickFiles',

  windowSetFullScreen: 'openbot:window:setFullScreen',
  windowIsFullScreen: 'openbot:window:isFullScreen',

  appVersion: 'openbot:app:version',
  appCheckUpdate: 'openbot:app:checkUpdate',
  appOpenRelease: 'openbot:app:openRelease'
} as const
