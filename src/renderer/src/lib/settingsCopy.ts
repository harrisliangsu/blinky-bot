/**
 * Settings copy. Written for BlinkyBot; the section names follow the
 * owner's outline. English and Chinese stay key-for-key.
 */

export type SettingsLang = 'en' | 'zh-CN'

export interface SettingsCopy {
  title: string
  subtitle: string
  search: string
  close: string
  nav: Record<'general' | 'bots' | 'profile' | 'notifications' | 'permissions' | 'backends' | 'mcp' | 'updates' | 'about', string>
  general: {
    appearance: string
    theme: string
    themeHint: string
    system: string
    light: string
    dark: string
    vibrant: string
    vibrantHint: string
    language: string
    languageHint: string
    followSystem: string
    scale: string
    scaleHint: string
    accent: string
    accentHint: string
    accentTheme: string
    conversation: string
    send: string
    sendHint: string
    sendEnter: string
    sendMod: string
    steps: string
    stepsHint: string
    links: string
    linksHint: string
    linksBrowser: string
    linksWindow: string
    behavior: string
    login: string
    loginHint: string
    background: string
    backgroundHint: string
    privacy: string
  }
  bots: {
    mode: string
    modeHint: string
    backend: string
    backendHint: string
    model: string
    modelHint: string
    memory: string
    memoryHint: string
    memoryApi: string
    memoryAll: string
    memoryOff: string
  }
  profile: {
    name: string
    nameHint: string
    emoji: string
    color: string
    preview: string
  }
  notifications: {
    desktop: string
    desktopHint: string
    turn: string
    turnHint: string
  }
  permissions: {
    title: string
    policy: string
    askEvery: string
    askOnce: string
    allowlist: string
    auto: string
    askEveryHint: string
    askOnceHint: string
    allowlistHint: string
    autoHint: string
    autoWarn: string
    allow: string
    allowHint: string
    deny: string
    denyHint: string
    rules: string
    rulesHint: string
    rulesPlaceholder: string
    computer: string
    computerHint: string
    computerEmpty: string
  }
  backends: {
    title: string
    refresh: string
    empty: string
    local: string
    cloud: string
    tools: string
    baseUrl: string
    baseUrlPlaceholder: string
    apiKey: string
    show: string
    hide: string
    saveKey: string
    clear: string
    command: string
    commandPlaceholder: string
    stored: string
    notRequired: string
    keyPlaceholder: string
    status: Record<'available' | 'not-installed' | 'not-running' | 'needs-key' | 'error', string>
  }
  mcp: {
    title: string
    add: string
    intro: string
    addEndpoint: string
    catalogHint: string
    empty: string
    name: string
    account: string
    accountPlaceholder: string
    transport: string
    url: string
    auth: string
    none: string
    oauth: string
    bearer: string
    token: string
    tokenStored: string
    tokenPlaceholder: string
    oauthHint: string
    command: string
    args: string
    argsPlaceholder: string
    disabledTools: string
    disabledHint: string
    cancel: string
    save: string
    noUrl: string
    noCommand: string
    connected: string
    removed: string
  }
  updates: {
    version: string
    channel: string
    channelHint: string
    stable: string
    beta: string
    check: string
    checking: string
    open: string
    hint: string
  }
  about: {
    blurb: string
    license: string
    source: string
    credits: string
  }
  more: { title: string; projects: string; routines: string; archived: string; chats: string; bots: string }
}

const en: SettingsCopy = {
  title: 'Settings',
  subtitle: 'Stored on this machine.',
  search: 'Search settings',
  close: 'Close dialog',
  nav: {
    general: 'General',
    bots: 'Assistants',
    profile: 'Profile',
    notifications: 'Notifications',
    permissions: 'Permissions',
    backends: 'Backends',
    mcp: 'MCP',
    updates: 'Updates',
    about: 'About'
  },
  general: {
    appearance: 'Appearance',
    theme: 'Theme',
    themeHint: 'Light, dark, or the same as this Mac.',
    system: 'System',
    light: 'Light',
    dark: 'Dark',
    vibrant: 'Translucent window',
    vibrantHint: 'Let the desktop show through the window. On a Mac this also turns on vibrancy.',
    language: 'Language',
    languageHint: 'Settings and the sidebar use this language.',
    followSystem: 'Follow system',
    scale: 'Interface size',
    scaleHint: 'Scales the whole window.',
    accent: 'Accent color',
    accentHint: 'Used for focus, working state, and highlights.',
    accentTheme: 'Theme',
    conversation: 'Conversation',
    send: 'Send shortcut',
    sendHint: 'How a message leaves the composer.',
    sendEnter: 'Enter to send',
    sendMod: '⌘/Ctrl + Enter to send',
    steps: 'Show assistant steps',
    stepsHint: 'Start each tool step expanded.',
    links: 'External links',
    linksHint: 'Where a link from chat opens.',
    linksBrowser: 'Default browser',
    linksWindow: 'Window in BlinkyBot',
    behavior: 'App behavior',
    login: 'Launch at login',
    loginHint: 'Opens BlinkyBot when you sign in to this Mac. Applies to the installed app.',
    background: 'Run in background',
    backgroundHint: 'Keep scheduled routines alive after the window closes.',
    privacy: 'No account. No telemetry. Nothing leaves this machine except calls to the model backend you configure.'
  },
  bots: {
    mode: 'Default mode for new chats',
    modeHint: 'Agent can use tools. Ask and Plan stay read-only.',
    backend: 'Default backend',
    backendHint: 'New bots start here. A signed-in CLI is chosen automatically when this one is missing.',
    model: 'Default model',
    modelHint: 'Used with the default backend.',
    memory: 'Learn from conversations',
    memoryHint: 'Where a short follow-up call may save durable facts.',
    memoryApi: 'Direct APIs only',
    memoryAll: 'Every backend',
    memoryOff: 'Off'
  },
  profile: {
    name: 'Display name',
    nameHint: 'Shown on this Mac only. It is not an account.',
    emoji: 'Avatar',
    color: 'Avatar color',
    preview: 'This is how you appear in the sidebar.'
  },
  notifications: {
    desktop: 'Desktop notifications',
    desktopHint: 'Approvals, help requests, and failed runs notify when the window is in the background.',
    turn: 'Notify when a turn finishes',
    turnHint: 'Also notify after a reply completes in the background.'
  },
  permissions: {
    title: 'Computer use and approvals',
    policy: 'Approval policy',
    askEvery: 'Ask every time',
    askOnce: 'Ask once per action',
    allowlist: 'Allowlist',
    auto: 'Auto-run',
    askEveryHint: 'Every mutating action waits for you.',
    askOnceHint: 'Approve an action once, then it repeats freely.',
    allowlistHint: 'Run listed commands without asking; ask for everything else.',
    autoHint: 'Never ask, except for destructive actions and anything outside the working folder.',
    autoWarn: 'Auto-run answers approvals for you. Work outside the working folder and anything destructive still asks.',
    allow: 'Allowlist',
    allowHint: 'Commands that never need approval.',
    deny: 'Denylist',
    denyHint: 'Never run these, whatever the policy says.',
    rules: 'Global rules',
    rulesHint: 'Prepended to every bot’s system prompt.',
    rulesPlaceholder: 'House rules that apply to every bot',
    computer: 'Computer use',
    computerHint: 'Apps a bot may see and control. Use * to allow all of them.',
    computerEmpty: 'No apps are granted yet, so computer use is off. Add an app above before asking a bot to drive one.'
  },
  backends: {
    title: 'Backends and models',
    refresh: 'Refresh',
    empty: 'No backends detected. Install a CLI or add an API key, then refresh.',
    local: 'local',
    cloud: 'cloud',
    tools: 'tools',
    baseUrl: 'Base URL',
    baseUrlPlaceholder: 'Leave empty for the default endpoint',
    apiKey: 'API key',
    show: 'Show',
    hide: 'Hide',
    saveKey: 'Save key',
    clear: 'Clear',
    command: 'Command',
    commandPlaceholder: 'Executable to launch',
    stored: 'Stored securely — type to replace',
    notRequired: 'Not required for local backends',
    keyPlaceholder: 'Stored in the OS credential store',
    status: {
      available: 'signed in',
      'not-installed': 'not installed',
      'not-running': 'not running',
      'needs-key': 'needs sign-in',
      error: 'error'
    }
  },
  mcp: {
    title: 'MCP servers',
    add: 'Add server',
    intro: 'Connect a local or remote MCP server. Tokens stay in the OS keychain.',
    addEndpoint: 'Add its MCP endpoint',
    catalogHint: 'A card only starts a remote account. Paste the endpoint the provider publishes. BlinkyBot does not ship those URLs.',
    empty: 'No MCP servers configured.',
    name: 'Name',
    account: 'Account label',
    accountPlaceholder: 'Work, personal, team…',
    transport: 'Transport',
    url: 'Remote MCP URL',
    auth: 'Authentication',
    none: 'None',
    oauth: 'OAuth (handled by the agent CLI)',
    bearer: 'Bearer token',
    token: 'Bearer token',
    tokenStored: 'Stored securely — leave blank to keep',
    tokenPlaceholder: 'Stored in the OS keychain',
    oauthHint: 'A compatible agent CLI opens the provider’s sign-in the first time it connects.',
    command: 'Command',
    args: 'Arguments',
    argsPlaceholder: 'Space separated',
    disabledTools: 'Disabled tools',
    disabledHint: 'Comma-separated tool names for clients that can hide tools.',
    cancel: 'Cancel',
    save: 'Save',
    noUrl: 'No URL set',
    noCommand: 'No command set',
    connected: 'connected',
    removed: 'That MCP server was removed, so the editor closed without saving.'
  },
  updates: {
    version: 'Installed version',
    channel: 'Update channel',
    channelHint: 'Stable reads the Sparkle appcast. Beta looks for a GitHub prerelease.',
    stable: 'Stable',
    beta: 'Beta',
    check: 'Check now',
    checking: 'Checking…',
    open: 'Open release',
    hint: 'BlinkyBot does not install the update by itself. Check now looks, and Open release downloads it.'
  },
  about: {
    blurb: 'BlinkyBot is a local-first Mac app for the agent CLIs and API keys you already have.',
    license: 'MIT License',
    source: 'Source on GitHub',
    credits: 'An MIT fork of OpenBOT. Not affiliated with or endorsed by the OpenBOT authors.'
  },
  more: {
    title: 'More',
    projects: 'Projects',
    routines: 'Routines',
    archived: 'Archived',
    chats: 'Chats',
    bots: 'Bots'
  }
}

const zh: SettingsCopy = {
  title: '设置',
  subtitle: '保存在这台电脑上。',
  search: '搜索设置',
  close: '关闭对话框',
  nav: {
    general: '通用',
    bots: '助手',
    profile: '个人资料',
    notifications: '通知',
    permissions: '权限',
    backends: '后端',
    mcp: 'MCP',
    updates: '更新',
    about: '关于'
  },
  general: {
    appearance: '外观',
    theme: '主题',
    themeHint: '浅色、深色，或与这台 Mac 一致。',
    system: '跟随系统',
    light: '浅色',
    dark: '深色',
    vibrant: '透明窗口',
    vibrantHint: '让桌面透出窗口。在 Mac 上同时开启系统磨砂效果。',
    language: '语言',
    languageHint: '设置和侧边栏使用这个语言。',
    followSystem: '跟随系统',
    scale: '界面大小',
    scaleHint: '缩放整个窗口。',
    accent: '标志颜色',
    accentHint: '用于焦点、进行中状态和高亮。',
    accentTheme: '跟随主题',
    conversation: '对话',
    send: '发送快捷键',
    sendHint: '消息如何从输入框发出。',
    sendEnter: '按 Enter 发送',
    sendMod: '按 ⌘/Ctrl + Enter 发送',
    steps: '显示助手步骤',
    stepsHint: '工具步骤默认展开。',
    links: '打开外部链接的方式',
    linksHint: '对话里的链接在哪里打开。',
    linksBrowser: '默认浏览器',
    linksWindow: '在 BlinkyBot 窗口中打开',
    behavior: '应用行为',
    login: '登录时启动',
    loginHint: '登录这台 Mac 时打开 BlinkyBot。对已安装的应用生效。',
    background: '后台运行',
    backgroundHint: '窗口关闭后，定时例程仍然继续。',
    privacy: '没有账号，没有遥测。除了你配置的模型后端，不会有数据离开这台电脑。'
  },
  bots: {
    mode: '新对话的默认模式',
    modeHint: 'Agent 可以使用工具。Ask 和 Plan 只读。',
    backend: '默认后端',
    backendHint: '新建的 Bot 从这里开始。当前后端不可用时，会自动改用已登录的 CLI。',
    model: '默认模型',
    modelHint: '与默认后端一起使用。',
    memory: '从对话中学习',
    memoryHint: '允许在一轮结束后用一次短调用记下稳定事实。',
    memoryApi: '仅直接 API',
    memoryAll: '所有后端',
    memoryOff: '关闭'
  },
  profile: {
    name: '显示名称',
    nameHint: '只显示在这台 Mac 上，不是账号。',
    emoji: '头像',
    color: '头像颜色',
    preview: '侧边栏里会这样显示你。'
  },
  notifications: {
    desktop: '桌面通知',
    desktopHint: '窗口在后台时，审批、求助和失败的运行会通知你。',
    turn: '一轮结束时通知',
    turnHint: '后台完成回复时也通知。'
  },
  permissions: {
    title: '权限与电脑使用',
    policy: '审批策略',
    askEvery: '每次都问',
    askOnce: '同一操作只问一次',
    allowlist: '允许列表',
    auto: '自动运行',
    askEveryHint: '每次会改动的操作都等你确认。',
    askOnceHint: '同一操作批准一次后可以重复。',
    allowlistHint: '列表里的命令直接运行，其余仍要询问。',
    autoHint: '除了破坏性操作和工作目录之外的事，不再询问。',
    autoWarn: '自动运行会替你回答审批。工作目录之外和破坏性操作仍然会问。',
    allow: '允许列表',
    allowHint: '这些命令不需要审批。',
    deny: '拒绝列表',
    denyHint: '无论策略如何，都不运行这些命令。',
    rules: '全局规则',
    rulesHint: '会加在每个 Bot 的系统提示前面。',
    rulesPlaceholder: '适用于每个 Bot 的约定',
    computer: '电脑使用',
    computerHint: 'Bot 可以查看和控制的应用。用 * 表示全部允许。',
    computerEmpty: '还没有授权任何应用，所以电脑使用是关闭的。先在上面添加应用。'
  },
  backends: {
    title: '后端与模型',
    refresh: '刷新',
    empty: '没有发现后端。安装 CLI 或添加 API key 后刷新。',
    local: '本地',
    cloud: '云端',
    tools: '工具',
    baseUrl: '基础 URL',
    baseUrlPlaceholder: '留空则使用默认地址',
    apiKey: 'API key',
    show: '显示',
    hide: '隐藏',
    saveKey: '保存密钥',
    clear: '清除',
    command: '命令',
    commandPlaceholder: '要启动的可执行文件',
    stored: '已安全保存 — 输入新值即可替换',
    notRequired: '本地后端不需要',
    keyPlaceholder: '保存在系统凭据库中',
    status: {
      available: '已登录',
      'not-installed': '未安装',
      'not-running': '未运行',
      'needs-key': '需要登录',
      error: '出错'
    }
  },
  mcp: {
    title: 'MCP',
    add: '添加服务器',
    intro: '连接本地或远程 MCP 服务器。令牌保存在系统钥匙串里。',
    addEndpoint: '添加它的 MCP 地址',
    catalogHint: '卡片只是开始一个远程账号。请粘贴服务商公布的地址。BlinkyBot 不自带这些 URL。',
    empty: '还没有配置 MCP 服务器。',
    name: '名称',
    account: '账号标签',
    accountPlaceholder: '工作、个人、团队…',
    transport: '传输方式',
    url: '远程 MCP URL',
    auth: '认证',
    none: '无',
    oauth: 'OAuth（由 Agent CLI 处理）',
    bearer: 'Bearer 令牌',
    token: 'Bearer 令牌',
    tokenStored: '已安全保存 — 留空则保持不变',
    tokenPlaceholder: '保存在系统钥匙串中',
    oauthHint: '兼容的 Agent CLI 会在第一次连接时打开服务商的登录页。',
    command: '命令',
    args: '参数',
    argsPlaceholder: '用空格分隔',
    disabledTools: '停用的工具',
    disabledHint: '用逗号分隔。支持按工具隐藏的客户端会用到。',
    cancel: '取消',
    save: '保存',
    noUrl: '未设置 URL',
    noCommand: '未设置命令',
    connected: '已连接',
    removed: '这个 MCP 服务器已被删除，编辑器已关闭且没有保存。'
  },
  updates: {
    version: '当前版本',
    channel: '更新通道',
    channelHint: '稳定通道读取 Sparkle appcast。测试通道查找 GitHub 预发布版本。',
    stable: '稳定',
    beta: '测试',
    check: '立即检查',
    checking: '正在检查…',
    open: '打开发布页',
    hint: 'BlinkyBot 不会自己安装更新。立即检查只负责查看，打开发布页再下载。'
  },
  about: {
    blurb: 'BlinkyBot 是装在这台 Mac 上的本地应用，使用你已经有的 Agent CLI 和 API key。',
    license: 'MIT 许可',
    source: 'GitHub 源码',
    credits: 'OpenBOT 的 MIT 分支。与 OpenBOT 作者没有隶属或背书关系。'
  },
  more: {
    title: '更多',
    projects: '项目',
    routines: '例程',
    archived: '已归档',
    chats: '对话',
    bots: '助手'
  }
}

const DICTS: Record<SettingsLang, SettingsCopy> = { en, 'zh-CN': zh }

export function resolveSettingsLang(preference: string | undefined, systemLang: string): SettingsLang {
  if (preference === 'en' || preference === 'zh-CN') return preference
  return systemLang.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

export function settingsCopy(lang: SettingsLang): SettingsCopy {
  return DICTS[lang]
}

/** Flat key list so a test can prove the two languages describe the same controls. */
export function copyLeaves(value: unknown, prefix = ''): string[] {
  if (typeof value === 'string') return [prefix]
  if (!value || typeof value !== 'object') return []
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    copyLeaves(child, prefix ? `${prefix}.${key}` : key)
  )
}
