# 更新记录

## 0.2.2

- **默认 Bot 使用已登录的 CLI。** BlinkyBot 会在图形界面也能看见的 PATH 里查找，包括 `/opt/homebrew/bin`、`~/.local/bin`、npm 全局目录和 nvm 的版本目录，并把默认 Bot 指到已安装且已登录的后端。顺序是 Codex、Claude Code、OpenCode，然后是其他 CLI，最后是 API key。
- **缺少 CLI 时会说明原因。** 没有任何已登录的后端时，对话会说明这一点，并打开设置里的 Backends，而不是显示 `spawn opencode ENOENT`。

## 0.2.0

- **BlinkyBot 打包的是 OpenBOT 桌面应用。** Mac 上的应用名是 BlinkyBot，源码是这棵 OpenBOT 树。
- **磁盘映像和 zip。** 发布物是 Apple 芯片的 `BlinkyBot-0.2.0.dmg` 和 `BlinkyBot-0.2.0.zip`。不需要 Docker。
- **签名的更新源。** zip 使用 BlinkyBot 现有的更新密钥签名。这一版还没有应用内更新，请安装磁盘映像。
- **MIT 许可。** 这一版的源代码是 git tag `v0.2.0`。协议全文是 `LICENSE`。
