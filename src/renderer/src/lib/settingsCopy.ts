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
  nav: Record<
    'general' | 'bots' | 'profile' | 'notifications' | 'permissions' | 'backends' | 'vault' | 'apps' | 'tools' | 'updates' | 'about',
    string
  >
  account: {
    menu: string
    more: string
  }
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
    themeUseLight: string
    themeUseDark: string
    layout: {
      title: string
      chats: string
      chatsHint: string
      chatsOpen: string
      chatsClose: string
      side: string
      sideHint: string
      inbox: string
      inboxHint: string
      inboxOpen: string
      rooms: string
      roomsHint: string
      roomsOpen: string
    }
  }
  bots: {
    mode: string
    modeHint: string
    modeAgent: string
    modeAsk: string
    modePlan: string
    backend: string
    backendHint: string
    follow: string
    followHint: string
    model: string
    modelHint: string
    source: string
    sourceCli: string
    sourceProvider: string
    runtimeCli: string
    runtimeProvider: string
    runtimeModel: string
    runtimeModelDefault: string
    thinking: string
    thinkingHint: string
    thinkingDefault: string
    thinkingOff: string
    thinkingLow: string
    thinkingMedium: string
    thinkingHigh: string
    thinkingXHigh: string
    thinkingMax: string
    thinkingUltra: string
    thinkingUnavailable: string
    fast: string
    fastHint: string
    fastUnavailable: string
    eachBot: string
    eachBotHint: string
    runtimeEmpty: string
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
    cliPolicyCaveat: string
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
    keyPlaceholder: string
    localCli: string
    providers: string
    optionalKey: string
    optionalKeyPlaceholder: string
    cliEmpty: string
    providersEmpty: string
    providersEmptyHint: string
    manage: string
    usable: string
    addProvider: string
    addProviderDone: string
    addCli: string
    addCliDone: string
    removeProvider: string
    removeProviderConfirm: string
    confirmRemove: string
    cancelRemove: string
    login: string
    recheck: string
    loginPending: string
    loginFailed: string
    slashLoginHint: string
    searchCatalog: string
    removeCli: string
    removeCliConfirm: string
    defaultModel: string
    cliDefaultModel: string
    catalogEmpty: string
    isDefault: string
    cliAuth: Record<'not-installed' | 'logged-out' | 'logged-in' | 'unknown', string>
    detail: {
      needsKey: string
      notFound: string
      installWith: string
      installOr: string
      installFrom: string
      notInstalled: string
      setCommand: string
      versionTimeout: string
      needsSignIn: string
      found: string
      keyAccepted: string
      keyAcceptedModels: string
      disabled: string
      timedOut: string
      notChecked: string
      kimiSignIn: string
      grokSignIn: string
      grokKey: string
      unreachable: string
      checkFailed: string
      signInUnknown: string
    }
    status: Record<'available' | 'not-installed' | 'not-running' | 'needs-key' | 'error', string>
  }
  mcp: {
    title: string
    add: string
    intro: string
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
  tools: {
    intro: string
    skillsTitle: string
    skillsIntro: string
    skillsInstall: string
    skillsLoading: string
    skillsEmpty: string
    skillsShared: string
    skillsRemove: string
  }
  apps: {
    title: string
    intro: string
    refresh: string
    connect: string
    connected: string
    disconnected: string
    unavailable: string
    pending: string
    comingSoon: string
    githubTitle: string
    githubHint: string
    githubMissing: string
    githubLoginFailed: string
    gitTitle: string
    gitHint: string
    gitName: string
    gitEmail: string
    gitSave: string
    gitMissing: string
    gitInvalid: string
    gitFailed: string
    gmailTitle: string
    gmailHint: string
  }
  chat: {
    ready: string
    emptyTitle: string
    emptyBody: string
    placeholder: string
    send: string
    stop: string
    running: string
    openProviders: string
    imageTooBig: string
    queueLabel: string
    queuedCount: string
    pauseQueue: string
    resumeQueue: string
    queueWaiting: string
    queueSending: string
    queueInterrupted: string
    removeQueued: string
    queuedAttachments: string
    queueFailed: string
    queueResumeFailed: string
    steer: string
    steerHint: string
    steerUnsupported: string
    steerFailed: string
    enqueue: string
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
  more: { bots: string; search: string }
}

const en: SettingsCopy = {
  title: 'Settings',
  subtitle: 'Stored on this machine.',
  search: 'Search settings',
  close: 'Close dialog',
  nav: {
    general: 'General',
    bots: 'Bots',
    profile: 'Profile',
    notifications: 'Notifications',
    permissions: 'Permissions',
    backends: 'Agents',
    vault: 'Vault',
    apps: 'Apps',
    tools: 'Tools',
    updates: 'Updates',
    about: 'About'
  },
  account: {
    menu: 'Settings menu',
    more: 'More…'
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
    steps: 'Show bot steps',
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
    privacy: 'Settings are saved on this device. Connected services and tools can send data outside it.',
    themeUseLight: 'Use light theme',
    themeUseDark: 'Use dark theme',
    layout: {
      title: 'Layout',
      chats: 'Several chats',
      chatsHint: 'Tile more than one conversation. Alt+G does the same.',
      chatsOpen: 'Open',
      chatsClose: 'Close',
      side: 'Activity panel',
      sideHint: 'The screen, and what this Bot still has to do.',
      inbox: 'Inbox',
      inboxHint: 'Background tasks, and work that finished while you were elsewhere.',
      inboxOpen: 'Open',
      rooms: 'Shared rooms',
      roomsHint: 'Invite someone on this network into a conversation.',
      roomsOpen: 'Open'
    }
  },
  bots: {
    mode: 'Default mode for new Bots',
    modeHint: 'Bot can use tools. Ask and Plan request read-only behavior; enforcement depends on the selected CLI.',
    modeAgent: 'Bot',
    modeAsk: 'Ask',
    modePlan: 'Plan',
    backend: 'Default CLI',
    backendHint: 'Used as the initial selection for new Bots; existing Bots keep their own choice.',
    follow: 'Use the default CLI',
    followHint: 'This Bot uses the default CLI, its default model, and the default thinking depth from Settings.',
    model: 'Default model',
    modelHint: 'Used as the initial model for new Bots.',
    source: 'Source',
    sourceCli: 'Local CLI',
    sourceProvider: 'Provider',
    runtimeCli: 'Local CLI',
    runtimeProvider: 'Provider',
    runtimeModel: 'Model',
    runtimeModelDefault: 'CLI or provider default',
    thinking: 'Thinking depth',
    thinkingHint: 'How hard a Bot thinks before it answers. Hidden when that CLI or provider has no depth control.',
    thinkingDefault: 'Default',
    thinkingOff: 'Off',
    thinkingLow: 'Low',
    thinkingMedium: 'Medium',
    thinkingHigh: 'High',
    thinkingXHigh: 'Extra high',
    thinkingMax: 'Max',
    thinkingUltra: 'Ultra',
    thinkingUnavailable: 'This model has no thinking control.',
    fast: 'Fast lane',
    fastHint: 'Route over the provider’s fast channel. Faster responses at a higher price. Hidden when that provider or model has no fast lane.',
    fastUnavailable: 'This model has no fast lane.',
    eachBot: 'Each Bot',
    eachBotHint: 'Each Bot keeps its own CLI or provider, model, and thinking depth.',
    runtimeEmpty: 'No usable local CLI or provider yet. Add one under Local CLIs & providers.',
    memory: 'Learn from conversations',
    memoryHint: 'Where a short follow-up call may save durable facts.',
    memoryApi: 'Direct APIs only',
    memoryAll: 'Every CLI and provider',
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
    desktopHint: 'Approvals, help requests, failed runs and returned Agent results notify when the app is in the background.',
    turn: 'Notify after AI replies',
    turnHint: 'Notify after a successful reply, in foreground and background. No conversation text is included.'
  },
  permissions: {
    title: 'Computer use and approvals',
    policy: 'Approval policy',
    askEvery: 'Ask every time',
    askOnce: 'Ask once per action',
    allowlist: 'Allowlist',
    auto: 'Auto-run',
    askEveryHint: 'Every app-managed mutating action waits for you.',
    askOnceHint: 'Approve an app-managed action once, then it repeats freely.',
    allowlistHint: 'Run listed app-managed commands without asking; ask for the rest.',
    autoHint: 'Ordinary app-managed actions run without asking. Forced requests, including computer control, network POSTs and high-risk commands, need confirmation; deny rules still apply.',
    autoWarn: 'Auto-run can make local changes without a prompt. Some commands are still blocked by application rules.',
    cliPolicyCaveat: 'CLI-owned tools do not all pass through BlinkyBot rules. Codex uses its workspace sandbox and native automatic review for requested escalations; workspace changes may not be reviewed. Kimi and Grok permission requests need confirmation, but existing native allow rules may not ask.',
    allow: 'Allowlist',
    allowHint: 'App-managed commands that do not need approval.',
    deny: 'Denylist',
    denyHint: 'App-managed commands on this list never run, whatever the policy says.',
    rules: 'Global rules',
    rulesHint: 'Prepended to every bot’s system prompt.',
    rulesPlaceholder: 'House rules that apply to every bot',
    computer: 'Computer use',
    computerHint: 'Apps a bot may see and control. Use * to allow all of them.',
    computerEmpty: 'No apps are granted yet, so computer use is off. Add an app above before asking a bot to drive one.'
  },
  backends: {
    title: 'Local CLIs and providers',
    refresh: 'Refresh',
    empty: 'Nothing is configured yet. Add a provider or a local CLI.',
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
    keyPlaceholder: 'Stored in the OS credential store',
    localCli: 'Local CLIs',
    providers: 'Providers',
    optionalKey: 'API key (optional)',
    optionalKeyPlaceholder: 'Only if the CLI is not signed in',
    cliEmpty: 'No CLIs yet.',
    providersEmpty: 'No providers yet',
    providersEmptyHint: 'Add one to use a cloud API key and base URL.',
    manage: 'Manage',
    usable: 'available',
    addProvider: 'Add provider',
    addProviderDone: 'Every provider is already listed.',
    addCli: 'Add',
    addCliDone: 'Every CLI is already listed.',
    removeProvider: 'Remove',
    removeProviderConfirm: 'Removing this provider also clears the key saved for it.',
    confirmRemove: 'Remove provider',
    cancelRemove: 'Cancel',
    login: 'Sign in',
    recheck: 'Check again',
    loginPending: 'Finish sign-in in Terminal. This row checks again when you come back.',
    loginFailed: 'Could not open Terminal for this CLI.',
    slashLoginHint: 'Terminal opens this CLI. Type /login there to sign in.',
    searchCatalog: 'Search',
    removeCli: 'Remove from list',
    removeCliConfirm: 'This only hides the CLI. The program stays installed on this Mac.',
    defaultModel: 'Default model',
    cliDefaultModel: 'CLI default',
    catalogEmpty: 'No match.',
    isDefault: 'Default',
    cliAuth: {
      'not-installed': 'not installed',
      'logged-out': 'not signed in',
      'logged-in': 'signed in',
      unknown: 'unknown'
    },
    detail: {
      needsKey:
        'API key required — add {article} {label} key in Settings ({hint}). It is stored locally, encrypted by the OS credential store, and sent only to {label}’s own API host.',
      notFound: '`{command}` was not found on your PATH. {install}',
      installWith: 'Install with {options}.',
      installOr: ' or ',
      installFrom: 'Install it from {url}.',
      notInstalled: 'Not installed.',
      setCommand: 'Set a command for {name} in Settings — any binary speaking its protocol works.',
      versionTimeout:
        '{name} did not answer a version check within the probe window — it may be waiting on first-run setup. Run `{command}` once in a terminal.',
      needsSignIn: '{name} is installed{where} but has no configuration yet — run `{command}` once and sign in.',
      found: '{name} found{where}.',
      keyAccepted: 'Key accepted.',
      keyAcceptedModels: 'Key accepted — {count} model{suffix} available.',
      disabled: 'Disabled in Settings.',
      timedOut: 'Detection timed out.',
      notChecked: 'Not checked yet.',
      kimiSignIn: '{name} is installed but not signed in. Run `{command} login` in a terminal, then refresh.',
      grokSignIn:
        '{name} is installed but not signed in. Run `{command} login` in a terminal, or save an xAI API key on this row.',
      grokKey: '{name} is installed. The API key saved on this row is passed as XAI_API_KEY.',
      unreachable: 'Could not reach {host} — check your network connection.',
      checkFailed: '{label} check failed: {error}',
      signInUnknown: '{name} is installed{where}, but its sign-in state could not be checked.'
    },
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
    empty: 'No MCP servers configured.',
    name: 'Name',
    account: 'Account label',
    accountPlaceholder: 'Work, personal, team…',
    transport: 'Transport',
    url: 'Remote MCP URL',
    auth: 'Authentication',
    none: 'None',
    oauth: 'OAuth (handled by the local CLI)',
    bearer: 'Bearer token',
    token: 'Bearer token',
    tokenStored: 'Stored securely — leave blank to keep',
    tokenPlaceholder: 'Stored in the OS keychain',
    oauthHint: 'A compatible local CLI opens the provider’s sign-in the first time it connects.',
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
  tools: {
    intro: 'MCP servers and skills for every Bot. Apps stays GitHub, Git, and Gmail.',
    skillsTitle: 'Skills',
    skillsIntro: 'Install a folder into the shared directory, then assign it on each Bot.',
    skillsInstall: 'Install',
    skillsLoading: 'Looking for skills…',
    skillsEmpty: 'No skills installed yet.',
    skillsShared: 'shared',
    skillsRemove: 'Remove'
  },
  apps: {
    title: 'Apps',
    intro: 'GitHub and Git settings on this Mac are shared by Bots.',
    refresh: 'Check again',
    connect: 'Connect',
    connected: 'Connected',
    disconnected: 'Not connected',
    unavailable: 'Unavailable',
    pending: 'Waiting for sign-in',
    comingSoon: 'Coming soon',
    githubTitle: 'GitHub',
    githubHint: 'Signs in with the GitHub CLI. BlinkyBot does not keep the token.',
    githubMissing: 'Install GitHub CLI (gh), then connect.',
    githubLoginFailed: 'Could not open Terminal for GitHub sign-in.',
    gitTitle: 'Git',
    gitHint: 'Saves the global Git name and email on this Mac. Every Bot uses that identity.',
    gitName: 'Name',
    gitEmail: 'Email',
    gitSave: 'Save Git identity',
    gitMissing: 'Git is not installed.',
    gitInvalid: 'Enter a name and an email address.',
    gitFailed: 'Git could not save that identity.',
    gmailTitle: 'Gmail',
    gmailHint: 'Google sign-in is not in this build.'
  },
  chat: {
    ready: 'Ready when you are',
    emptyTitle: 'What should Blinky work on?',
    emptyBody: 'Ask a question or describe what you would like to do.',
    placeholder: 'Message this Bot…',
    send: 'Send',
    stop: 'Stop',
    running: 'Running — Esc to stop',
    openProviders: 'Open Settings → Providers',
    imageTooBig: 'That image is too large to attach.',
    queueLabel: 'Message queue',
    queuedCount: 'Queued {count}',
    pauseQueue: 'Pause',
    resumeQueue: 'Resume',
    queueWaiting: 'Waiting',
    queueSending: 'Sending',
    queueInterrupted: 'Execution status unknown; inspect the conversation before removing',
    removeQueued: 'Remove queued message',
    queuedAttachments: 'Images or attachments ({count})',
    queueFailed: 'The message could not be sent. Please try again.',
    queueResumeFailed: 'Resolve the interrupted message before resuming the queue.',
    steer: 'Steer',
    steerHint: 'Send guidance to the running Codex turn',
    steerUnsupported: 'Live guidance is available for Codex; other backends can queue messages.',
    steerFailed: 'Could not confirm whether guidance was applied. Check the run before trying again.',
    enqueue: 'Queue'
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
    blurb: 'BlinkyBot is a local-first Mac app for the local CLIs and API keys you already have.',
    license: 'MIT License',
    source: 'Source on GitHub',
    credits: 'An MIT fork of OpenBOT. Not affiliated with or endorsed by the OpenBOT authors.'
  },
  more: {
    bots: 'Bots',
    search: 'Search bots'
  }
}

const zh: SettingsCopy = {
  title: '设置',
  subtitle: '保存在这台电脑上。',
  search: '搜索设置',
  close: '关闭对话框',
  nav: {
    general: '通用',
    bots: 'Bot',
    profile: '个人资料',
    notifications: '通知',
    permissions: '权限',
    backends: 'Agent',
    vault: '保险库',
    apps: '应用',
    tools: '工具',
    updates: '更新',
    about: '关于'
  },
  account: {
    menu: '设置菜单',
    more: '其他…'
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
    steps: '显示 Bot 步骤',
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
    privacy: '设置保存在这台设备；连接的服务和工具可能向外发送数据。',
    themeUseLight: '改用浅色',
    themeUseDark: '改用深色',
    layout: {
      title: '布局',
      chats: '多个对话',
      chatsHint: '并排看好几段对话。Alt+G 同样可以。',
      chatsOpen: '打开',
      chatsClose: '关闭',
      side: '活动面板',
      sideHint: '这个 Bot 的屏幕，以及还没做完的事。',
      inbox: '收件箱',
      inboxHint: '后台任务，以及你不在时已经做完的事。',
      inboxOpen: '打开',
      rooms: '共享房间',
      roomsHint: '邀请同一局域网上的人加入一段对话。',
      roomsOpen: '打开'
    }
  },
  bots: {
    mode: '新 Bot 的默认模式',
    modeHint: 'Bot 可以使用工具。Ask 和 Plan 要求只读，实际限制取决于所选 CLI。',
    modeAgent: 'Bot',
    modeAsk: 'Ask',
    modePlan: 'Plan',
    backend: '默认 CLI',
    backendHint: '作为新 Bot 的初始选择；已有 Bot 保留各自的设置。',
    follow: '使用默认 CLI',
    followHint: '这个 Bot 使用设置里的默认 CLI、默认模型和思考深度。',
    model: '默认模型',
    modelHint: '作为新 Bot 的初始模型。',
    source: '来源',
    sourceCli: '本地 CLI',
    sourceProvider: '供应商',
    runtimeCli: '本地 CLI',
    runtimeProvider: '供应商',
    runtimeModel: '模型',
    runtimeModelDefault: 'CLI 或供应商默认',
    thinking: '思考深度',
    thinkingHint: 'Bot 回答前思考多深。所选本地 CLI 或供应商没有这项时不显示。',
    thinkingDefault: '默认',
    thinkingOff: '关闭',
    thinkingLow: '低',
    thinkingMedium: '中',
    thinkingHigh: '高',
    thinkingXHigh: '极高',
    thinkingMax: '最大',
    thinkingUltra: '超高',
    thinkingUnavailable: '这个模型没有思考深度。',
    fast: '快速通道',
    fastHint: '走供应商的快速通道，响应更快、费用更高。所选供应商或模型没有快速通道时不显示。',
    fastUnavailable: '这个模型没有快速通道。',
    eachBot: '每个 Bot',
    eachBotHint: '每个 Bot 单独保存本地 CLI 或供应商、模型和思考深度。',
    runtimeEmpty: '还没有可用的本地 CLI 或供应商。请先在「本地 CLI 与供应商」里添加。',
    memory: '从对话中学习',
    memoryHint: '允许在一轮结束后用一次短调用记下稳定事实。',
    memoryApi: '仅直接 API',
    memoryAll: '每个 CLI 和供应商',
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
    turn: 'AI 回复后通知',
    turnHint: '成功回复后通知，前台和后台均生效；不包含对话正文。'
  },
  permissions: {
    title: '权限与电脑使用',
    policy: '审批策略',
    askEvery: '每次都问',
    askOnce: '同一操作只问一次',
    allowlist: '允许列表',
    auto: '自动运行',
    askEveryHint: '由 BlinkyBot 管理的改动操作，每次都等你确认。',
    askOnceHint: '由应用管理的同一操作批准一次后可以重复。',
    allowlistHint: '应用管理的命令中，列表里的直接运行，其余仍要询问。',
    autoHint: '应用管理的普通操作自动运行；电脑操作、网络 POST、高风险命令等强制确认的请求仍需批准，禁止规则仍然生效。',
    autoWarn: '自动运行可直接修改本地内容；应用的禁止规则仍可能阻止部分命令。',
    cliPolicyCaveat: 'CLI 自带工具不一定经过 BlinkyBot 的规则。Codex 对申请提权的操作使用原生自动复审，工作区内改动不一定经过复审；Kimi 和 Grok 发起审批的操作需要确认，但原生已允许的规则可能不询问。',
    allow: '允许列表',
    allowHint: '由应用管理的这些命令不需要审批。',
    deny: '拒绝列表',
    denyHint: '无论策略如何，BlinkyBot 管理的这些命令都不会运行。',
    rules: '全局规则',
    rulesHint: '会加在每个 Bot 的系统提示前面。',
    rulesPlaceholder: '适用于每个 Bot 的约定',
    computer: '电脑使用',
    computerHint: 'Bot 可以查看和控制的应用。用 * 表示全部允许。',
    computerEmpty: '还没有授权任何应用，所以电脑使用是关闭的。先在上面添加应用。'
  },
  backends: {
    title: '本地 CLI 与供应商',
    refresh: '刷新',
    empty: '还没有配置。添加供应商或本地 CLI。',
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
    keyPlaceholder: '保存在系统凭据库中',
    localCli: '本地 CLI',
    providers: '供应商',
    optionalKey: 'API key（可选）',
    optionalKeyPlaceholder: 'CLI 未登录时才需要',
    cliEmpty: '还没有可用的 CLI。',
    providersEmpty: '还没有添加供应商',
    providersEmptyHint: '添加后可使用云端 API Key / Base URL',
    manage: '管理',
    usable: '可用',
    addProvider: '添加供应商',
    addProviderDone: '供应商都已添加。',
    addCli: '添加',
    addCliDone: 'CLI 都已添加。',
    removeProvider: '移除',
    removeProviderConfirm: '移除后，为这个供应商保存的密钥也会清除。',
    confirmRemove: '确认移除',
    cancelRemove: '取消',
    login: '登录',
    recheck: '重新检测',
    loginPending: '请在终端里完成登录。回到这个窗口后会自动再检查。',
    loginFailed: '无法打开终端来登录这个 CLI。',
    slashLoginHint: '终端会打开这个 CLI。在里面输入 /login 完成登录。',
    searchCatalog: '搜索',
    removeCli: '从列表移除',
    removeCliConfirm: '只是从列表里拿掉。这台 Mac 上的程序还在。',
    defaultModel: '默认模型',
    cliDefaultModel: 'CLI 默认',
    catalogEmpty: '没有匹配。',
    isDefault: '默认',
    cliAuth: {
      'not-installed': '未安装',
      'logged-out': '未登录',
      'logged-in': '已登录',
      unknown: '未知'
    },
    detail: {
      needsKey:
        '需要 API key — 请在设置里添加 {label} 的密钥（{hint}）。密钥保存在这台电脑上，由系统凭据库加密，并且只发给 {label} 自己的 API 地址。',
      notFound: '在 PATH 上找不到 `{command}`。{install}',
      installWith: '可以用 {options} 安装。',
      installOr: ' 或 ',
      installFrom: '请从 {url} 安装。',
      notInstalled: '未安装。',
      setCommand: '请在设置里为 {name} 填写命令。任何使用同一协议的可执行文件都可以。',
      versionTimeout: '{name} 在探测时间内没有回应版本检查，可能停在首次设置。请在终端运行一次 `{command}`。',
      needsSignIn: '{name} 已安装{where}，但还没有配置。请在终端运行一次 `{command}` 并登录。',
      found: '已找到 {name}{where}。',
      keyAccepted: '密钥可用。',
      keyAcceptedModels: '密钥可用 — 有 {count} 个模型。',
      disabled: '已在设置中停用。',
      timedOut: '检测超时。',
      notChecked: '尚未检查。',
      kimiSignIn: '{name} 已安装，但还没有登录。请在终端运行 `{command} login`，然后刷新。',
      grokSignIn: '{name} 已安装，但还没有登录。请在终端运行 `{command} login`，或在这一行保存 xAI API key。',
      grokKey: '{name} 已安装。这一行保存的 API key 会作为 XAI_API_KEY 传给它。',
      unreachable: '无法连接 {host} — 请检查网络。',
      checkFailed: '{label} 检查失败：{error}',
      signInUnknown: '{name} 已安装{where}，但无法确认登录状态。'
    },
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
    empty: '还没有配置 MCP 服务器。',
    name: '名称',
    account: '账号标签',
    accountPlaceholder: '工作、个人、团队…',
    transport: '传输方式',
    url: '远程 MCP URL',
    auth: '认证',
    none: '无',
    oauth: 'OAuth（由本地 CLI 处理）',
    bearer: 'Bearer 令牌',
    token: 'Bearer 令牌',
    tokenStored: '已安全保存 — 留空则保持不变',
    tokenPlaceholder: '保存在系统钥匙串中',
    oauthHint: '兼容的本地 CLI 会在第一次连接时打开服务商的登录页。',
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
  tools: {
    intro: '每个 Bot 都能用的 MCP 服务器和技能。应用只放 GitHub、Git 和 Gmail。',
    skillsTitle: '技能',
    skillsIntro: '安装到共享目录后，再到每个 Bot 上选用。',
    skillsInstall: '安装',
    skillsLoading: '正在查找技能…',
    skillsEmpty: '还没有安装技能。',
    skillsShared: '共享',
    skillsRemove: '移除'
  },
  apps: {
    title: '应用',
    intro: '这台 Mac 上的 GitHub 和 Git 设置由各 Bot 共用。',
    refresh: '重新检查',
    connect: '连接',
    connected: '已连接',
    disconnected: '未连接',
    unavailable: '不可用',
    pending: '等待登录',
    comingSoon: '即将推出',
    githubTitle: 'GitHub',
    githubHint: '用 GitHub CLI 登录。BlinkyBot 不保存令牌。',
    githubMissing: '请先安装 GitHub CLI（gh），再连接。',
    githubLoginFailed: '无法打开终端来登录 GitHub。',
    gitTitle: 'Git',
    gitHint: '把 Git 的全局姓名和邮箱写在这台 Mac 上。每个 Bot 都用这个身份。',
    gitName: '姓名',
    gitEmail: '邮箱',
    gitSave: '保存 Git 身份',
    gitMissing: '还没有安装 Git。',
    gitInvalid: '请填写姓名和邮箱。',
    gitFailed: 'Git 没能保存这个身份。',
    gmailTitle: 'Gmail',
    gmailHint: '这一版还没有 Google 登录。'
  },
  chat: {
    ready: '可以开始了',
    emptyTitle: '让 Blinky 做什么？',
    emptyBody: '直接提问或描述你想完成的事。',
    placeholder: '给这个 Bot 发消息…',
    send: '发送',
    stop: '停止',
    running: '正在运行 — 按 Esc 停止',
    openProviders: '打开设置 → 供应商',
    imageTooBig: '这张图片太大，附不上。',
    queueLabel: '消息队列',
    queuedCount: '待发送 {count}',
    pauseQueue: '暂停',
    resumeQueue: '继续',
    queueWaiting: '等待中',
    queueSending: '发送中',
    queueInterrupted: '执行状态未确认，请检查对话后移除',
    removeQueued: '移除待发送消息',
    queuedAttachments: '图片或附件 ({count})',
    queueFailed: '消息未能发送，请重试。',
    queueResumeFailed: '请先处理未确认的消息，再恢复队列。',
    steer: '引导',
    steerHint: '将文字发送给正在执行的 Codex',
    steerUnsupported: '实时引导支持 Codex；其他执行器可以排队发送。',
    steerFailed: '未确认引导是否生效，请检查当前任务后再试。',
    enqueue: '排队'
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
    blurb: 'BlinkyBot 是装在这台 Mac 上的本地应用，使用你已经有的本地 CLI 和 API key。',
    license: 'MIT 许可',
    source: 'GitHub 源码',
    credits: 'OpenBOT 的 MIT 分支。与 OpenBOT 作者没有隶属或背书关系。'
  },
  more: {
    bots: 'Bot',
    search: '搜索 Bot'
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
