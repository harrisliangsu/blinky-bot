# 发行方注册与人工验收方案（未执行外部动作）

目标：普通用户从“应用”页进入系统浏览器同意授权，不创建开发者应用、不填写 API key/token。发行方为每个服务注册属于 BlinkyBot 的公共客户端，并把公开的 client ID 随应用主进程发布。当前没有这些生产 client ID，不能把本地实现和模拟验证视为开箱即用已完成。

以下是可审阅的操作方案，不是已发生的注册、审核、部署或账号测试。注册/审核/付款必须由有相应权限的发行方执行或另行明确授权；不用在聊天中提供 token。不要复用 Grok/OpenBot/其他 CLI 的应用身份或读取其账号配置。

## 从发行到 Bot / Agent 工具可用

1. **发行方准备**：按下文分别登记自有客户端、精确回调和权限，完成适用审核/分发。随主进程构建注入公开的 `MAIN_VITE_GOOGLE_CLIENT_ID`、`MAIN_VITE_X_CLIENT_ID`、`MAIN_VITE_SLACK_CLIENT_ID`、`MAIN_VITE_GITHUB_CLIENT_ID`；仅 Google Desktop 注册确实要求时携带 `MAIN_VITE_GOOGLE_CLIENT_SECRET`。GitHub 的令牌端点同样要求 client secret，因此另注入 `MAIN_VITE_GITHUB_CLIENT_SECRET`：它和 Google Desktop secret 一样可被桌面提取，不是可保密的服务端 secret，并用 PKCE 绑定授权码。不要把 Web/Slack confidential-client secret、账号 token 或刷新令牌放进桌面包、renderer、版本库或日志。`BLINKY_*` 运行时覆盖仅供本地发行调试，不能代替普通安装用户的发行配置。
2. **构建回读**：使用独立源码和输出目录，核对最终 ASAR 中实际 `googleClient/xClientId/slackClientId/githubClient` 所引用的构建对象是否含有效公开客户端，并记录包哈希。只做源码环境变量检查不证明发布包已预置。无配置的构建必须显示发行方尚未启用，不能把普通登录按钮变成申请开发者应用的表单。应用页不再提供自带客户端。
3. **用户连接**：当前应用页只提供 GitHub、Gmail 和 X。GitHub 使用 BlinkyBot 自己的 GitHub App 用户授权，在浏览器中同意，不再调用 `gh auth login`，也不把本机 `gh` 登录当作已连接。Gmail 和 X 同样在浏览器中授权。Git 姓名/邮箱不是应用。Calendar 与 Slack 连接器仍在进程内，但不出现在应用页，普通用户不能从应用或设置里连接或授权它们。拒绝、错误回调和取消不得覆盖已有有效连接。缺少发行方客户端时显示尚未启用，不能把普通登录按钮变成申请开发者应用的表单。
4. **工具授权接点**：GitHub、Gmail 和 X 一旦在本机保存连接，每个非 VM Bot 都可以使用该应用的读取和本地草稿工具。这不再是按 Bot 勾选的允许名单。VM 目标仍由工具注册表拒绝宿主连接器。发送仍走原有确认。专属执行 Agent 由 `bindExecutionAgent` 继承 Bot 自己的工具，并同样得到已连接应用的工具，不应再次索要 provider 凭据。
5. **实际调用**：Gmail 为 `list_google_accounts/search_gmail/read_gmail/gmail_draft`；Calendar 为账户发现、`list_calendar_events/calendar_event_draft`；X 为 `read_x_post/x_post_draft`；Slack 为 `slack_message_draft`；GitHub 为 `github_comment_draft` 与另行授予的例程工具。应用页的 Gmail 授权不包含 `watch_gmail_query`。没有实现的邮箱附件、Slack 历史搜索、任意 GitHub API 等不能由“已连接”推导为已有能力。写入走本地草稿及逐次确认。自动发送规则已停用，保存的规则不会发信，模型无直接发送出口。
6. **宿主范围**：API/应用内模型通过应用工具循环；Codex、Claude、OpenCode、Kimi、Grok 的已支持适配器通过本机、会话限权 MCP 网关。未列入运行时 MCP 支持的 CLI 不等于已经具备同样工具；VM 目标当前拒绝访问宿主账号，不能暗中退回本机。网关启动失败须报告失败。连接器假服务验证不替代各真实 CLI/模型和发布包验收。
7. **受控验收**：先用虚拟身份/假服务完成同意、刷新、逐账号选择、错误回调、断连、重启、Bot 与执行 Agent 的工具发现/调用、越权拒绝和零提前外发。再由有权限的测试人员在专用账号验证真实同意、API 权限及系统加密；真实发送另行授权。保留包、源码和测试哈希，区分“代码存在、包内存在、假服务调用通过、真实授权通过”。使用隔离数据、合成服务和独立输出的真实 Preview 窗口验证；系统拒绝的操作不重试。

没有注册/审核/运营权限时，可完成实现、模拟链路和上述发布清单，但不能宣称已经向普通用户交付开箱即用的真实授权。托管 OAuth 平台或可见源码方案也不会自动取得 BlinkyBot 自有客户端和用户同意。

## 状态与可继续工作

| 服务/能力 | 本地可继续且已实现 | 真正外部阻挡 | 所需账号权限/外部动作 |
|---|---|---|---|
| GitHub | BlinkyBot GitHub App 用户授权（PKCE、固定 loopback）、每个非 VM Bot 的 `github_comment_draft`、刷新/断连；确认草稿后才调用 Issues 评论接口 | 缺少 BlinkyBot 的 GitHub App、Issues 读写权限和精确回调。旧的 `gh auth login` 不再算作已连接 | 能创建 GitHub App 的发行方。用户自行浏览器安装/同意。组织资源另需组织允许。不使用经典 OAuth App 的 `repo` scope |
| Gmail/Calendar | Desktop PKCE、发行方预置、Gmail 对每个非 VM Bot 的读取/草稿、刷新/断连、跨进程恢复测试。Calendar 仍不在应用页 | 缺少 BlinkyBot 的 Google Desktop client、API 启用、同意屏幕及适用审核 | 能管理 Google Cloud 项目/API 和 Google Auth Platform 的发行方；域名/隐私政策所有者；组织内部接入时可能需要 Workspace 管理员 |
| X | Native public client PKCE、刷新/断连、既有帖子工具与草稿、跨进程恢复 | 缺少 BlinkyBot 的 Native client 和 API 产品访问权 | X 开发者应用所有者/编辑者；按服务商当前要求开通 API/计费；注册精确回调 |
| Slack 用户授权 | 新增 Desktop PKCE，仅 user scopes；现有 Bot 草稿工具复用、确认后发送；刷新/断连/恢复 | 缺少 Slack 公共客户端和分发配置，可能需工作区管理员批准 | 可创建/管理 Slack App 的发行方；在受管工作区安装需对应管理员同意；用户自行浏览器授权 |
| Slack 自动接收/Bot 身份 | 保留原 Socket Mode，旧连接兼容，用户授权不会启动接收器 | 桌面用户 PKCE不能授予 bot scopes 或生成 app-level token；仍需管理员设置，或独立托管安装服务 | Slack App 所有者配置 Socket Mode、事件和 xapp/xoxb；如要 Add to Slack Bot 体验，另需 HTTPS 服务和服务端凭据存储 |

## GitHub：GitHub App 用户授权，不用 `gh auth login`

1. 发行方在自己的 GitHub 账号创建 **GitHub App**（不要创建经典 OAuth App，也不要复用 `gh` 的应用身份）。经典 OAuth App 没有“仅 Issues”的 scope，`repo` 会授予仓库内容权限；本应用不使用该权限。
2. 精确登记回调 `http://127.0.0.1:47841/oauth/github/callback`。应用只监听这个地址，端口被占用时授权失败，不改用未登记端口。GitHub 对 loopback 还允许登记 `http://127.0.0.1/oauth/github/callback`（端口不必一致）；仍应登记上面的精确 URL，避免关闭通配后回调不匹配。
3. 仓库权限只开 **Issues: Read and write**。GitHub 会自动加上 Metadata: Read。不要开 Contents、Pull requests、Administration，不要启用 device flow。授权请求的 scope 只有 `offline_access`（GitHub App 唯一接受的 scope，用于刷新令牌）。不要请求 `repo`、`read:org` 或 `gist`。
4. 构建注入 GitHub App 的 **Client ID**（不是数字 App ID）到 `MAIN_VITE_GITHUB_CLIENT_ID`。令牌端点要求 client secret，注入 `MAIN_VITE_GITHUB_CLIENT_SECRET`。该 secret 可从桌面包提取，必须配合 PKCE，不得提交到仓库。变量名和空值见仓库根目录 `.env.example`；真实值放在环境变量或未跟踪的 `.env.local`。打包脚本在 `MAIN_VITE_GOOGLE_CLIENT_ID`、`MAIN_VITE_X_CLIENT_ID`、`MAIN_VITE_GITHUB_CLIENT_ID`、`MAIN_VITE_GITHUB_CLIENT_SECRET` 任一为空时停止，且不打印值。`MAIN_VITE_GOOGLE_CLIENT_SECRET` 仅在 Google Desktop 注册要求时填写。X 不使用 secret。此打包门不包含 Slack。测试覆盖只用 `BLINKY_GITHUB_CLIENT_ID` / `BLINKY_GITHUB_CLIENT_SECRET`（Google/X 对应 `BLINKY_GOOGLE_CLIENT_ID`、`BLINKY_GOOGLE_CLIENT_SECRET`、`BLINKY_X_CLIENT_ID`）。
5. 任一值缺失时，应用页显示发行方尚未启用，浏览器登录按钮不可用。高级选项才允许用户填写自己的客户端。旧的 `gh auth login` 以及 `github-connection.json` 版本 1 的启用标记都不再视为已连接；断开只删除本应用加密保存的刷新令牌，不执行 `gh auth logout`，也不撤销 github.com 上的浏览器会话。
6. 连接成功只为所选 Bot 授予已有的 `github_comment_draft`。模型仍只能创建本地草稿；发送继续走受信任的草稿卡片，调用 `POST /repos/{owner}/{repo}/issues/{issue_number}/comments`（Issue 评论和 PR 对话评论）。不授予 `watch_github_issue`；已经单独授予的监视仍用同一令牌读取 Issue。不新增可被模型调用的发送工具。

人工验收（未执行）：专用账号点击 GitHub“浏览器登录”→确认同意屏幕属于 BlinkyBot 且只有 Issues 读写→只创建本地评论草稿并取消→退出重启后仍能刷新→断开后读/发失败且 `gh` 登录仍在。真实发送必须另行明确授权。

来源：[GitHub App 用户访问令牌](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)、[授权 OAuth 应用中的 loopback 与 PKCE](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)。

## Google：同一发行方 Desktop client，分别授权服务

1. 由发行方在 Google Cloud 选择或新建属于 BlinkyBot 的项目。新建项目、启用服务、提交审核均属于尚未执行的外部动作。
2. 启用 **Gmail API** 和 **Google Calendar API**。配置 Google Auth Platform 的应用名称、支持邮箱、受众（内部或外部）、由发行方拥有的主页和隐私政策 URL。测试账号由发行方添加，不能假设任意用户都可在 Testing 状态接入。
3. 创建 OAuth client，应用类型必须是 **Desktop app**，名称建议 `BlinkyBot Desktop`。使用系统浏览器和临时 `127.0.0.1` 回调；不要创建 Web application 后把其服务端 secret 填进桌面应用。
4. 声明当前实现实际使用的 scopes：Gmail 为 `openid email gmail.readonly gmail.send`（完整 URI 以 `googleOAuth.ts` 为准）；Calendar 为 `openid email calendar.events`。`gmail.readonly` 是受限权限，公开分发应按 Google 当前政策准备审核/适用安全评估；不要把添加测试用户当成通过审核。
5. 在发行方构建环境设置 `MAIN_VITE_GOOGLE_CLIENT_ID`，如该 **Desktop** 注册提供并要求 secret，则设置 `MAIN_VITE_GOOGLE_CLIENT_SECRET`。这不是可保密的服务端 secret；桌面可提取。不得填入用户 refresh token、API key、service account key，也不要提交真实值到仓库。
6. 构建后以临时 profile 人工验收；审核完成并经正式发布流程才能向普通用户分发。

**设备授权替代结论**：[Google 官方设备流](https://developers.google.com/identity/protocols/oauth2/limited-input-device#allowedscopes) 仍需要注册 client，而且允许 scopes 列表不包含本实现所需 Gmail/Calendar 权限。它不能消除本项目注册/审核前置条件。没有用 `gcloud` 的登录或其他应用 client 伪装这条路径。

人工验收（未执行）：在专用测试账号点击 Gmail/Calendar“浏览器登录”→确认同意屏幕属于 BlinkyBot且权限正确→仅访问测试人员明确指定的邮件/日程→退出应用重新启动并确认能刷新→撤权后显示不可用→重新授权→断连后读工具失败、重启仍断开。邮件/邀请先建草稿并取消；如要真实发送，必须另行明确授权和指定收件人。

来源：[Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)、[Gmail scopes/审核](https://developers.google.com/workspace/gmail/api/auth/scopes)、[Google 官方 Apache-2.0 库](https://github.com/googleapis/google-auth-library-nodejs)。本次按官方协议独立实现，未复制库代码。

## X：Native public client，无客户端 secret

1. 发行方在自己的 X Developer Console 创建或选择 BlinkyBot 应用，确认 API 产品访问权与费用。不要复制任何其他应用已有 client ID/API key。
2. 在 User authentication settings 启用 OAuth 2.0，选择 **Native App（public client）**；配置 Read and write 权限与由发行方拥有的真实网站信息。
3. 精确登记 `http://127.0.0.1:47839/oauth/x/callback`。固定端口被占用时本地授权应失败，不擅自更换未登记回调。
4. 为当前实现授权 `tweet.read tweet.write users.read offline.access`。只将公开的 OAuth 2.0 Client ID 注入 `MAIN_VITE_X_CLIENT_ID`。不能把 API key、Bearer app-only token 或 Web/Automated App secret 当成此值。
5. 人工测试人员用专用账号自行完成浏览器同意；验证 `/2/users/me`、明确指定的一条测试帖子、刷新令牌轮换、撤权错误、退出重启和断连。只建本地发帖草稿并取消，真实发布另需授权。

没有在本次核查的 X 官方协议中找到可免注册且替代此 Native PKCE 的设备授权；不实现模拟设备登录。来源：[官方 PKCE 与客户端类型](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code)。

## Slack：无需 token 输入的用户授权

1. 发行方使用有创建应用权限的工作区账号，在 Slack **Create New App → From a manifest** 中审阅并导入同目录 `slack-user-manifest.json`。这里只准备 manifest，没有创建外部应用。
2. 使用新的 `BlinkyBot Desktop` 注册，不修改现有 Socket Mode 应用。PKCE 是公共客户端选项，Slack 官方说明启用后不可自行关闭；不要把既有生产 Bot 注册直接改造成公共客户端。
3. 检查 OAuth & Permissions：PKCE 开启，redirect 为 `http://localhost:47840/oauth/slack/callback`，只申请 **User Token Scopes**：`chat:write` 与频道/会话元信息读取 scopes。没有 bot scopes，没有 `connections:write`，没有 Events API 接收器。
4. 启用令牌轮换；根据目标工作区启用/完成分发安装配置。管理员限制的工作区仍需管理员批准；公开分发并不自动意味着获 Slack Marketplace 审核。
5. 只把公开 Client ID 注入 `MAIN_VITE_SLACK_CLIENT_ID`。**不需要、也不接收 Slack client secret**；不把发行方 secret 放在桌面包或 renderer。
6. 普通用户在 BlinkyBot 选“浏览器用户授权”、粘贴其有权限的频道链接并选择使用该连接的 Bot，点击授权后在浏览器选择工作区并同意。用户 ID 来自服务端核验，无需手填。`slack_message_draft` 继续只建草稿，发送走原有用户确认出口。
7. UI 清楚显示此模式不接收频道消息。浏览器拒绝/超时保留原连接；正在授权时选择“取消并断开”并再次确认，会同时移除旧本机 Slack 连接。关闭设置本身不会撤销已经打开的同意页；未完成流程不持久化且五分钟超时。

人工验收（未执行）：专用工作区/账号→浏览器授权后验证用户与频道→创建本地草稿，确认界面显示目标工作区/频道且没有提前发送→取消草稿→退出/重启→刷新轮换→撤权/缺少权限显示不可用→断连/重启不恢复。真实发送必须另行明确授权。app-level Socket Mode不能由此用户授权取得。

来源：[官方 PKCE](https://docs.slack.dev/authentication/using-pkce/)、[oauth.v2.access 用户 token/刷新](https://docs.slack.dev/reference/methods/oauth.v2.access/)、[chat.postMessage 支持用户 token](https://docs.slack.dev/reference/methods/chat.postMessage/)、[Slack 官方 MIT SDK](https://github.com/slackapi/node-slack-sdk)。没有复制 SDK 代码或凭据。

## 如果还要求“Add to Slack”安装 Bot并自动接收

这项不能靠桌面保存服务端 secret 完成。需要发行方另外审阅并授权以下外部方案，本任务未部署：

- 独立的 Slack 服务端应用注册，配置 bot scopes/事件和发行方拥有的 HTTPS OAuth callback；由发行方/工作区管理员审批安装。
- 在发行方控制的服务端保存 client secret、安装 token 和（若用 Socket Mode）app-level token，使用官方 OAuth 安装流程或许可兼容的 `@slack/oauth` InstallProvider；不能将这些 secret 随桌面包分发。
- 明确云端事件转发、桌面配对、租户隔离、撤权及保留策略后，再选择服务端代理调用/转发方案。不得在缺少这份范围和权限决定时擅自新增云服务或静默复制 Bot token 给桌面。
- 部署前用模拟 Slack 验证 state、回调、租户绑定、安装/断连/撤销与草稿发送；部署和真实工作区安装各自需要明确授权。

此接收能力属于真实外部条件阻挡；新的用户 PKCE 外发路径已经可以在发行方提供公共客户端后使用，两者不能混称。
