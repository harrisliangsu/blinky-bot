# 更新记录

## 0.3.0

- **设置改成侧边栏。** 通用、助手、个人资料、通知、权限、后端、MCP、更新和关于。搜索可以过滤。默认是中文，也可以改成英文。
- **每个开关都会保存。** 主题、透明窗口、语言、界面大小、标志颜色、发送快捷键、助手步骤、外部链接、登录时启动和后台运行都写在这台 Mac 上。立即检查会读取 Sparkle 更新源或 GitHub 测试版。
- **主窗口以助手为主。** 项目、例程和已归档对话收进「更多」。活动面板默认关闭。

## 0.2.2

- **默认 Bot 使用已登录的 CLI。** BlinkyBot 会在图形界面也能看见的 PATH 里查找，包括 `/opt/homebrew/bin`、`~/.local/bin`、`~/.kimi-code/bin`、`~/.grok/bin`、npm 全局目录和 nvm 的版本目录，并把默认 Bot 指到已安装且已登录的后端。顺序是 Codex、Claude Code、Kimi Code、Grok，然后是 OpenCode 和其他 CLI，最后是 API key。
- **缺少 CLI 时会说明原因。** 没有任何已登录的后端时，对话会说明这一点，并打开设置里的 Backends，而不是显示 `spawn opencode ENOENT`。

## 0.2.1

- **Kimi Code 和 Grok 是本机 CLI。** 可以和 Claude、Codex 一起选。BlinkyBot 会在登录 shell 的 PATH 里找 `kimi` 和 `grok`，也包括 `~/.kimi-code/bin` 和 `~/.grok/bin`。
- **登录留在这台 Mac 上。** 没有登录时会显示需要密钥。Grok 也可以用设置里保存的 xAI API key。写在 Kimi 那一行的密钥不会让 Kimi CLI 登录。
- **0.2.0 是打好的安装包。** 那一版把 BlinkyBot 磁盘映像恢复到这棵 OpenBOT 树上。这一版仍然没有应用内更新，请安装新的磁盘映像。

## 0.2.0

- **BlinkyBot 打包的是 OpenBOT 桌面应用。** Mac 上的应用名是 BlinkyBot，源码是这棵 OpenBOT 树。
- **磁盘映像和 zip。** 发布物是 Apple 芯片的 `BlinkyBot-0.2.0.dmg` 和 `BlinkyBot-0.2.0.zip`。不需要 Docker。
- **签名的更新源。** zip 使用 BlinkyBot 现有的更新密钥签名。这一版还没有应用内更新，请安装磁盘映像。
- **MIT 许可。** 这一版的源代码是 git tag `v0.2.0`。协议全文是 `LICENSE`。
