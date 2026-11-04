#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Bilingual GitHub Release body for one BlinkyBot version.

Chinese first, English second. These notes are the GitHub Release page.
This Electron build does not embed an in-app updater.

Usage:
    Scripts/release-notes.py 0.2.0
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHANGELOG_EN = ROOT / "CHANGELOG.md"
CHANGELOG_ZH = ROOT / "CHANGELOG.zh-CN.md"


def github_repo() -> str:
    """owner/name. CI sets GITHUB_REPOSITORY; a local run reads origin."""
    env = os.environ.get("GITHUB_REPOSITORY", "").strip()
    if env:
        return env
    result = subprocess.run(
        ["git", "remote", "get-url", "origin"],
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    url = result.stdout.strip()
    for prefix in ("git@github.com:", "https://github.com/", "ssh://git@github.com/"):
        if url.startswith(prefix):
            url = url[len(prefix) :]
            break
    if url.endswith(".git"):
        url = url[:-4]
    if not url:
        sys.exit("Could not tell which GitHub repository this is.")
    return url


def entry(path: Path, version: str) -> str | None:
    if not path.exists():
        return None
    text = path.read_text()
    pattern = rf"^## {re.escape(version)}\s*$(.*?)(?=^## |\Z)"
    match = re.search(pattern, text, re.M | re.S)
    if not match:
        return None
    body = match.group(1).strip()
    return body or None


def previous_version(version: str) -> str | None:
    """The version listed after `version` in CHANGELOG.md (newest first)."""
    if not CHANGELOG_EN.exists():
        return None
    versions = re.findall(r"^## (\d+\.\d+\.\d+(?:[-+][^\s]+)?)\s*$", CHANGELOG_EN.read_text(), re.M)
    try:
        index = versions.index(version)
    except ValueError:
        return None
    if index + 1 < len(versions):
        return versions[index + 1]
    return None


def install_zh(version: str) -> str:
    return "\n".join(
        [
            "## 安装",
            "",
            f"下载 **BlinkyBot-{version}.dmg**，打开后把 BlinkyBot 拖入「应用程序」。同一份应用也有 **BlinkyBot-{version}.zip**。",
            "",
            "这一版没有 Apple 公证。首次打开若被拦截：先打开 BlinkyBot 并关闭警告，再到 **系统设置 → 隐私与安全性 → 安全性 → 仍要打开**。只需一次。",
            "",
            "需要 macOS 14 或更高版本。GitHub 上的安装包是 Apple 芯片（arm64）。应用是 Electron 桌面端，不需要 Docker。",
            "",
            f"源代码是本仓库的 tag `v{version}`。许可协议是 MIT。协议全文是该 tag 上的 `LICENSE`。",
        ]
    )


def install_en(version: str) -> str:
    return "\n".join(
        [
            "## Install",
            "",
            f"Download **BlinkyBot-{version}.dmg**, open it, and drag BlinkyBot into Applications. **BlinkyBot-{version}.zip** is the same app.",
            "",
            "This build is not notarized. If macOS blocks the first launch, open BlinkyBot, dismiss the warning, then go to **System Settings → Privacy & Security → Security → Open Anyway**. Once only.",
            "",
            "Requires macOS 14 or newer. The package on GitHub is Apple Silicon (arm64). The app is an Electron desktop build. Docker is not required.",
            "",
            f"Source for this version is the git tag `v{version}`. Licensed under the MIT License. The license text is `LICENSE` at that tag.",
        ]
    )


def build(version: str) -> str:
    zh = entry(CHANGELOG_ZH, version)
    if not zh:
        sys.exit(f"CHANGELOG.zh-CN.md has no entry for {version}")

    en = entry(CHANGELOG_EN, version)
    if not en:
        sys.exit(f"CHANGELOG.md has no entry for {version}")

    prev = previous_version(version)
    repo = github_repo()
    compare = (
        f"https://github.com/{repo}/compare/v{prev}...v{version}"
        if prev
        else f"https://github.com/{repo}/releases/tag/v{version}"
    )

    if not prev:
        already_zh = "**首次安装？** 下载下方安装包即可。这一版还没有应用内更新。"
        already_en = "**First install?** Download the package below. This build has no in-app updater yet."
    else:
        already_zh = f"**已经在用 {prev}？** 下载这个磁盘映像，替换「应用程序」里的 BlinkyBot。{prev} 没有应用内更新。"
        already_en = (
            f"**Already using {prev}?** Download this disk image and replace BlinkyBot in Applications. "
            f"{prev} has no in-app updater."
        )

    parts = [
        f"[中文](#cn-blinkybot-{version}) | [English](#en-blinkybot-{version})",
        "",
        f'<h2 id="cn-blinkybot-{version}">BlinkyBot {version}</h2>',
        "",
        already_zh,
        "",
        "## 更新内容",
        "",
        zh,
        "",
        install_zh(version),
        "",
        f"**完整更新记录**：{compare}",
        "",
        "---",
        "",
        f'<h2 id="en-blinkybot-{version}">BlinkyBot {version}</h2>',
        "",
        already_en,
        "",
        "## What's new",
        "",
        en,
        "",
        install_en(version),
        "",
        f"**Full Changelog**: {compare}",
        "",
    ]
    return "\n".join(parts)


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    print(build(sys.argv[1]), end="")


if __name__ == "__main__":
    main()
