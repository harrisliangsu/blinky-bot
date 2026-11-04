# 更新记录

## 0.2.1

- **Kimi Code 和 Grok 是本机 CLI。** 可以和 Claude、Codex 一起选。BlinkyBot 会在登录 shell 的 PATH 里找 `kimi` 和 `grok`，也包括 `~/.kimi-code/bin` 和 `~/.grok/bin`。
- **登录留在这台 Mac 上。** 没有登录时会显示需要密钥。Grok 也可以用设置里保存的 xAI API key。写在 Kimi 那一行的密钥不会让 Kimi CLI 登录。
- **0.2.0 是打好的安装包。** 那一版把 BlinkyBot 磁盘映像恢复到这棵 OpenBOT 树上。这一版仍然没有应用内更新，请安装新的磁盘映像。

## 0.2.0

- **BlinkyBot 打包的是 OpenBOT 桌面应用。** Mac 上的应用名是 BlinkyBot，源码是这棵 OpenBOT 树。
- **磁盘映像和 zip。** 发布物是 Apple 芯片的 `BlinkyBot-0.2.0.dmg` 和 `BlinkyBot-0.2.0.zip`。不需要 Docker。
- **签名的更新源。** zip 使用 BlinkyBot 现有的更新密钥签名。这一版还没有应用内更新，请安装磁盘映像。
- **MIT 许可。** 这一版的源代码是 git tag `v0.2.0`。协议全文是 `LICENSE`。
