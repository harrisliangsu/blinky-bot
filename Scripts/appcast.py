#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Publish one BlinkyBot release in the Sparkle feed.

Sparkle installs an archive only when the EdDSA signature matches the public
key in the app. The private half is the SPARKLE_PRIVATE_KEY secret. It is
piped to sign_update and is not written into the repository.

    Scripts/appcast.py <version> <path-to-zip> <download-url>

The feed keeps one item, the newest. Archives are full zips, not deltas.
Chinese notes come from CHANGELOG.zh-CN.md (zh-Hans and zh-Hant). English
notes come from CHANGELOG.md. The app reads appcast.xml.

A second build of the same version rewrites that item's enclosure so the
signature matches the zip that was just uploaded.
"""

from __future__ import annotations

import email.utils
import html
import os
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import changelog  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
FEED = ROOT / "appcast.xml"
STYLE = """<style>
  h2 { font-size: 1.05em; margin: 0 0 .5em; }
  ul { margin: 0; padding-left: 1.2em; }
  li { margin: .3em 0; }
  p { margin: .8em 0 0; }
</style>"""
ITEM = re.compile(r"        <item>\n.*?        </item>\n", re.S)
ENCLOSURE = re.compile(r"[ \t]*<enclosure\b.*?/>", re.S)
DESCRIPTION = re.compile(
    r'[ \t]*<description(?: xml:lang="([^"]+)")?><!\[CDATA\[.*?\]\]></description>\n',
    re.S,
)


def github_repo() -> str:
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
            url = url[len(prefix):]
            break
    if url.endswith(".git"):
        url = url[:-4]
    if "/" not in url:
        sys.exit("Could not tell which GitHub repository this is.")
    return url


def feed_url(name: str, repo: str | None = None) -> str:
    slug = repo or github_repo()
    return f"https://github.com/{slug}/releases/latest/download/{name}"


def skeleton(repo: str | None = None) -> str:
    url = feed_url("appcast.xml", repo)
    return f"""<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
    <channel>
        <title>BlinkyBot</title>
        <link>{url}</link>
        <description>Updates for BlinkyBot.</description>
        <language>en</language>
    </channel>
</rss>
"""


def sign_archive(archive: Path) -> tuple[str, str]:
    tool = os.environ.get("SPARKLE_SIGN_UPDATE", "").strip()
    if not tool:
        sys.exit("sign_update not found. Set SPARKLE_SIGN_UPDATE to Sparkle's bin/sign_update.")
    key = os.environ.get("SPARKLE_PRIVATE_KEY", "").strip()
    command = [tool]
    if key:
        command += ["--ed-key-file", "-"]
    command.append(str(archive))
    result = subprocess.run(
        command,
        input=key + "\n" if key else None,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        sys.exit(f"sign_update failed ({result.returncode}):\n{result.stderr.strip()}")
    parts = {}
    for piece in result.stdout.replace('" ', '"\n').splitlines():
        if "=" not in piece:
            continue
        name, value = piece.split("=", 1)
        parts[name.strip()] = value.strip().strip('"')
    if "sparkle:edSignature" not in parts or "length" not in parts:
        sys.exit(f"sign_update did not print a signature:\n{result.stdout.strip()}")
    return parts["sparkle:edSignature"], parts["length"]


def notes_html(version: str, body: str, link_text: str, repo: str) -> str:
    link = f'<p><a href="{repo}/releases/tag/v{version}">{html.escape(link_text)}</a></p>'
    inner = f"{STYLE}<h2>BlinkyBot {html.escape(version)}</h2>{body}{link}"
    return inner.replace("]]>", "]]&gt;")


def descriptions(version: str, repo: str) -> str:
    elements: list[str] = []
    specs = (
        (changelog.CHANGELOG_ZH, ("zh-Hans", "zh-Hant"), "在 GitHub 查看更新说明"),
        (changelog.CHANGELOG, ("en",), "Release notes on GitHub"),
    )
    for path, langs, link_text in specs:
        written = changelog.entry(version, path)
        if not written:
            continue
        notes = notes_html(version, changelog.as_html(written), link_text, repo)
        for lang in langs:
            elements.append(f'<description xml:lang="{lang}"><![CDATA[{notes}]]></description>')
    if not elements:
        sys.exit(f"No changelog entry for {version}")
    return "\n            ".join(elements)


def enclosure(url: str, length: str, signature: str) -> str:
    return (
        f'            <enclosure url="{url}"\n'
        f'                       length="{length}"\n'
        f'                       type="application/octet-stream"\n'
        f'                       sparkle:edSignature="{signature}" />'
    )


def render_item(version: str, url: str, signature: str, length: str, notes: str, repo: str) -> str:
    published = email.utils.formatdate(localtime=False, usegmt=False)
    return (
        "        <item>\n"
        f"            <title>{html.escape(version)}</title>\n"
        f"            <pubDate>{published}</pubDate>\n"
        f"            <sparkle:version>{html.escape(version)}</sparkle:version>\n"
        f"            <sparkle:shortVersionString>{html.escape(version)}</sparkle:shortVersionString>\n"
        "            <sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion>\n"
        f"            <link>{repo}/releases/tag/v{version}</link>\n"
        f"            {notes}\n"
        f"{enclosure(url, length, signature)}\n"
        "        </item>\n"
    )


def upsert(feed: str, version: str, item: str) -> str:
    """Keep a single item. The same version keeps its notes and date and takes the new enclosure."""
    match = ITEM.search(feed)
    marker = f"<sparkle:shortVersionString>{version}</sparkle:shortVersionString>"
    if match and marker in match.group(0):
        new_enclosure = ENCLOSURE.search(item)
        if not new_enclosure:
            sys.exit("The new item has no enclosure.")
        replaced = ENCLOSURE.sub(new_enclosure.group(0), match.group(0), count=1)
        return feed[: match.start()] + replaced + feed[match.end():]
    if "</channel>" not in feed:
        sys.exit("appcast.xml has no channel.")
    without = ITEM.sub("", feed)
    return without.replace("</channel>", f"{item}    </channel>", 1)


def single_language(feed: str, langs: tuple[str, ...]) -> str:
    def cut(match: re.Match[str]) -> str:
        item = match.group(0)
        found = DESCRIPTION.findall(item)
        if len([lang for lang in found if lang]) < 2:
            return item
        keep = next((lang for lang in langs if lang in found), None)
        if keep is None:
            return item

        def one(description: re.Match[str]) -> str:
            if description.group(1) != keep:
                return ""
            return description.group(0).replace(f' xml:lang="{keep}"', "", 1)

        return DESCRIPTION.sub(one, item)

    return ITEM.sub(cut, feed)


def write_feeds(feed: str, repo: str) -> None:
    main_url = feed_url("appcast.xml", repo)
    feed = re.sub(
        r"<link>https://raw\.githubusercontent\.com/[^<]+</link>",
        f"<link>{main_url}</link>",
        feed,
        count=1,
    )
    FEED.write_text(feed)
    copies = (
        ("appcast-zh.xml", ("zh-Hans", "zh-Hant")),
        ("appcast-en.xml", ("en",)),
    )
    for name, langs in copies:
        copy = single_language(feed, langs).replace(main_url, feed_url(name, repo), 1)
        (ROOT / name).write_text(copy)


def publish(version: str, archive: Path, url: str) -> None:
    signature, length = sign_archive(archive)
    repo_url = f"https://github.com/{github_repo()}"
    notes = descriptions(version, repo_url)
    item = render_item(version, url, signature, length, notes, repo_url)
    current = FEED.read_text() if FEED.exists() else skeleton()
    write_feeds(upsert(current, version, item), github_repo())
    print(f"appcast.xml offers {version}.")


def main() -> None:
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    version, archive, url = sys.argv[1:]
    publish(version, Path(archive), url)


if __name__ == "__main__":
    main()
