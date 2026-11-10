/** Explicit transport policy. Adding an IPC handler never exposes it to the network. */
const reads = [
  'sessions:list', 'sessions:get', 'sessions:attachment',
  'bots:list', 'bots:get', 'bots:memory', 'bots:browserScope',
  'groups:list', 'projects:list', 'projects:get', 'projects:board',
  'tasks:list', 'tasks:summaries', 'tasks:get', 'tasks:clarifications',
  'routines:list', 'routines:get', 'routines:backgroundStatus',
  'skills:list', 'skills:refresh', 'skills:for',
  'backends:list', 'backends:refresh', 'backends:recheck',
  'apps:status', 'apps:slackStatus', 'settings:get', 'activity:list', 'search:query',
  'agent:isRunning', 'agent:liveMessages', 'agent:queue', 'rooms:list',
  'github-drafts:list', 'gmail-drafts:list', 'calendar-drafts:list', 'x-drafts:list', 'slack-drafts:list',
  'send-rules:list', 'vault:list', 'app:version'
]
const writes = [
  'remote:upload',
  'sessions:create', 'sessions:clear', 'sessions:archiveAndClear', 'sessions:rename', 'sessions:archive', 'sessions:unarchive', 'sessions:remove', 'sessions:setMode', 'sessions:setCwd', 'sessions:addBot', 'sessions:removeBot', 'sessions:setActiveBot', 'sessions:setProject', 'sessions:react',
  'bots:create', 'bots:update', 'bots:duplicate', 'bots:remove', 'bots:addMemory', 'bots:removeMemory',
  'groups:create', 'groups:update', 'groups:remove',
  'projects:create', 'projects:update', 'projects:remove', 'projects:addCard', 'projects:updateCard', 'projects:moveCard', 'projects:removeCard', 'projects:addColumn', 'projects:renameColumn', 'projects:setColumnDone', 'projects:removeColumn',
  'tasks:create', 'tasks:cancel', 'tasks:answerClarification', 'tasks:cancelClarification',
  'routines:createInstruction', 'routines:update', 'routines:remove', 'routines:run',
  'skills:install', 'skills:uninstall', 'skills:syncExisting',
  'settings:update', 'settings:saveProfile', 'settings:decisionReview', 'voice:language',
  'agent:send', 'agent:enqueue', 'agent:pauseQueue', 'agent:removeQueued', 'agent:stop', 'agent:steer',
  'activity:markRead', 'activity:clear', 'rooms:create', 'rooms:remove', 'rooms:qr'
]
export const remoteChannelPolicies: ReadonlyMap<string, 'read' | 'write'> = new Map([
  ...reads.map(channel => [`openbot:${channel}`, 'read'] as const),
  ...writes.map(channel => [`openbot:${channel}`, 'write'] as const)
])

export const remoteCapabilityLabels = [
  { id: 'chat', zh: '聊天、历史、实时回复、附件、停止与队列', en: 'Chat, history, live replies, attachments, stop and queue' },
  { id: 'workspace', zh: 'Bot、会话、分组、记忆及工作区导航', en: 'Bots, conversations, groups, memory and workspace navigation' },
  { id: 'tasks', zh: '任务、执行会话和普通澄清', en: 'Tasks, execution chats and ordinary questions' },
  { id: 'projects', zh: '项目与看板', en: 'Projects and boards' },
  { id: 'routines', zh: '例程及其已有受控执行路径', en: 'Routines and their existing controlled execution' },
  { id: 'skills', zh: '技能与已配置模型的管理', en: 'Skills and configured models' },
  { id: 'settings', zh: '外观、资料和常规偏好', en: 'Appearance, profile and ordinary preferences' },
  { id: 'host-only', zh: '系统/工具授权、凭据、账号登录、设备批准及本机设备操作仍在 Mac 完成', en: 'System/tool approvals, credentials, account login, device approval and native device actions remain on the Mac' }
] as const
