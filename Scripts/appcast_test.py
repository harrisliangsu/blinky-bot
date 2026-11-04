#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""The Sparkle feed writer, without a private key or sign_update."""

from __future__ import annotations

import unittest

import appcast


class FeedTests(unittest.TestCase):
    def test_feed_url_is_the_release_asset(self) -> None:
        url = appcast.feed_url("appcast.xml", "harrisliangsu/blinky-bot")
        self.assertEqual(url, "https://github.com/harrisliangsu/blinky-bot/releases/latest/download/appcast.xml")
        self.assertIn(url, appcast.skeleton("harrisliangsu/blinky-bot"))

    def test_one_item_carries_both_languages_and_a_full_zip(self) -> None:
        notes = appcast.descriptions("0.2.0", "https://github.com/harrisliangsu/blinky-bot")
        self.assertIn('xml:lang="zh-Hans"', notes)
        self.assertIn('xml:lang="en"', notes)
        item = appcast.render_item(
            "0.2.0",
            "https://github.com/harrisliangsu/blinky-bot/releases/download/v0.2.0/BlinkyBot-0.2.0.zip",
            "sig==",
            "10",
            notes,
            "https://github.com/harrisliangsu/blinky-bot",
        )
        feed = appcast.upsert(appcast.skeleton("harrisliangsu/blinky-bot"), "0.2.0", item)
        self.assertEqual(feed.count("<item>"), 1)
        self.assertIn('sparkle:edSignature="sig=="', feed)
        self.assertIn("BlinkyBot-0.2.0.zip", feed)
        self.assertNotIn("sparkle:delta", feed)
        self.assertIn("<sparkle:shortVersionString>0.2.0</sparkle:shortVersionString>", feed)

    def test_rebuilding_the_same_version_replaces_the_signature_and_keeps_the_notes(self) -> None:
        notes = appcast.descriptions("0.2.0", "https://github.com/harrisliangsu/blinky-bot")
        first = appcast.render_item(
            "0.2.0",
            "https://example.invalid/old.zip",
            "old==",
            "10",
            notes,
            "https://github.com/harrisliangsu/blinky-bot",
        )
        feed = appcast.upsert(appcast.skeleton("harrisliangsu/blinky-bot"), "0.2.0", first)
        date = appcast.ITEM.search(feed).group(0)
        second = appcast.render_item(
            "0.2.0",
            "https://example.invalid/new.zip",
            "new==",
            "11",
            notes,
            "https://github.com/harrisliangsu/blinky-bot",
        )
        updated = appcast.upsert(feed, "0.2.0", second)
        self.assertIn("new.zip", updated)
        self.assertIn('sparkle:edSignature="new=="', updated)
        self.assertNotIn("old.zip", updated)
        self.assertIn("<pubDate>", updated)
        self.assertIn(date.split("<pubDate>")[1].split("</pubDate>")[0], updated)
        self.assertEqual(updated.count('xml:lang="en"'), 1)

    def test_a_newer_version_replaces_the_previous_item(self) -> None:
        notes = appcast.descriptions("0.2.0", "https://github.com/harrisliangsu/blinky-bot")
        first = appcast.render_item(
            "0.2.0",
            "https://example.invalid/a.zip",
            "a==",
            "1",
            notes,
            "https://github.com/harrisliangsu/blinky-bot",
        )
        feed = appcast.upsert(appcast.skeleton("harrisliangsu/blinky-bot"), "0.2.0", first)
        newer_notes = notes.replace("0.2.0", "0.2.1")
        second = appcast.render_item(
            "0.2.1",
            "https://example.invalid/b.zip",
            "b==",
            "2",
            newer_notes,
            "https://github.com/harrisliangsu/blinky-bot",
        )
        updated = appcast.upsert(feed, "0.2.1", second)
        self.assertEqual(updated.count("<item>"), 1)
        self.assertIn("0.2.1", updated)
        self.assertNotIn("0.2.0.zip", updated)
        self.assertNotIn(">0.2.0<", updated)

    def test_chinese_copy_drops_the_english_description(self) -> None:
        notes = appcast.descriptions("0.2.0", "https://github.com/harrisliangsu/blinky-bot")
        item = appcast.render_item(
            "0.2.0",
            "https://example.invalid/a.zip",
            "a==",
            "1",
            notes,
            "https://github.com/harrisliangsu/blinky-bot",
        )
        feed = appcast.upsert(appcast.skeleton("harrisliangsu/blinky-bot"), "0.2.0", item)
        chinese = appcast.single_language(feed, ("zh-Hans", "zh-Hant"))
        self.assertIn("在 GitHub 查看更新说明", chinese)
        self.assertNotIn('xml:lang="en"', chinese)
        self.assertNotIn("Release notes on GitHub", chinese)


if __name__ == "__main__":
    unittest.main()
