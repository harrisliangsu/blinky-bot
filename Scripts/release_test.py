#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Checks release notes, the Sparkle public key, and that release automation stays off main."""

from __future__ import annotations

import importlib.util
import json
import os
import re
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = Path(__file__).resolve().parent
PUBLIC_KEY = "M/xUmNfKp+sEloy822L8X4lVdOLM1pv9srD7fw/bgb8="


def load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    if spec is None or spec.loader is None:
        raise RuntimeError(filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


changelog = load("changelog", "changelog.py")
release_notes = load("release_notes", "release-notes.py")


class ChangelogTest(unittest.TestCase):
    def test_english_and_chinese_entries_exist(self) -> None:
        english = changelog.entry("0.2.0")
        chinese = changelog.entry("0.2.0", changelog.CHANGELOG_ZH)
        self.assertIsNotNone(english)
        self.assertIsNotNone(chinese)
        assert english is not None and chinese is not None
        self.assertIn("BlinkyBot", english)
        self.assertIn("MIT", english)
        self.assertIn("BlinkyBot", chinese)
        self.assertIn("MIT", chinese)

    def test_0_2_1_notes_name_kimi_grok_and_the_packaged_0_2_0(self) -> None:
        english = changelog.entry("0.2.1")
        chinese = changelog.entry("0.2.1", changelog.CHANGELOG_ZH)
        self.assertIsNotNone(english)
        self.assertIsNotNone(chinese)
        assert english is not None and chinese is not None
        self.assertIn("Kimi", english)
        self.assertIn("Grok", english)
        self.assertIn("0.2.0", english)
        self.assertIn("Kimi", chinese)
        self.assertIn("Grok", chinese)
        self.assertIn("0.2.0", chinese)
        self.assertEqual(release_notes.previous_version("0.2.1"), "0.2.0")

    def test_missing_version_is_none(self) -> None:
        self.assertIsNone(changelog.entry("9.9.9"))

    def test_html_escapes_and_formats(self) -> None:
        html = changelog.as_html("- **Title.** Use `code` and <tag>. See [docs](https://example.com/a).")
        self.assertIn("<ul>", html)
        self.assertIn("<strong>Title.</strong>", html)
        self.assertIn("<code>code</code>", html)
        self.assertIn("&lt;tag&gt;", html)
        self.assertIn('href="https://example.com/a"', html)
        self.assertNotIn("<tag>", html)

    def test_cli_rejects_a_missing_entry(self) -> None:
        result = subprocess.run(
            [sys.executable, str(SCRIPTS / "changelog.py"), "9.9.9"],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("CHANGELOG.md", result.stderr)


class ReleaseNotesTest(unittest.TestCase):
    def test_bilingual_body_for_first_packaged_release(self) -> None:
        os.environ["GITHUB_REPOSITORY"] = "harrisliangsu/blinky-bot"
        body = release_notes.build("0.2.0")
        self.assertIn("BlinkyBot 0.2.0", body)
        self.assertIn("BlinkyBot-0.2.0.dmg", body)
        self.assertIn("BlinkyBot-0.2.0.zip", body)
        self.assertIn("MIT", body)
        self.assertIn("Apple Silicon", body)
        self.assertIn("首次安装", body)
        self.assertIn("First install", body)
        self.assertIn("https://github.com/harrisliangsu/blinky-bot/releases/tag/v0.2.0", body)
        self.assertNotIn("AGPL", body)
        self.assertIsNone(release_notes.previous_version("0.2.0"))

    def test_cli_prints_the_body(self) -> None:
        env = {**os.environ, "GITHUB_REPOSITORY": "harrisliangsu/blinky-bot"}
        result = subprocess.run(
            [sys.executable, str(SCRIPTS / "release-notes.py"), "0.2.0"],
            capture_output=True,
            text=True,
            env=env,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("## 安装", result.stdout)
        self.assertIn("## Install", result.stdout)


class SparkleKeyTest(unittest.TestCase):
    def test_public_key_matches_the_packaged_app(self) -> None:
        key = (SCRIPTS / "sparkle-public-key.txt").read_text(encoding="utf-8").strip()
        self.assertEqual(key, PUBLIC_KEY)
        package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        build = package["build"]
        self.assertEqual(build["productName"], "BlinkyBot")
        self.assertEqual(build["appId"], "bot.blinky.shell")
        self.assertEqual(package["version"], "0.3.6")
        self.assertIsNotNone(changelog.entry("0.2.2"))
        self.assertIsNotNone(changelog.entry("0.2.2", changelog.CHANGELOG_ZH))
        self.assertIsNotNone(changelog.entry(package["version"]))
        self.assertIsNotNone(changelog.entry(package["version"], changelog.CHANGELOG_ZH))
        info = build["mac"]["extendInfo"]
        self.assertEqual(info["SUPublicEDKey"], key)
        self.assertIn("/releases/latest/download/appcast.xml", info["SUFeedURL"])
        self.assertNotIn("openbot", build["appId"].lower())


class ReleaseWorkflowTest(unittest.TestCase):
    def test_release_workflow_does_not_push_main(self) -> None:
        text = (ROOT / ".github" / "workflows" / "release.yml").read_text(encoding="utf-8")
        self.assertNotIn("gh pr merge", text)
        for line in text.splitlines():
            if "git push" in line:
                self.assertIsNone(
                    re.search(r"(^|\s)main(\s|$)", line),
                    f"release workflow pushes main: {line}",
                )
        self.assertIn("SPARKLE_PRIVATE_KEY", text)
        self.assertIn("open-smoke.sh", text)
        self.assertIn("appcast-v", text)
        self.assertIn("Allow GitHub Actions to create and approve pull requests", text)
        self.assertIn("::warning::", text)
        self.assertNotIn("::error::No pull request", text)


if __name__ == "__main__":
    unittest.main()
