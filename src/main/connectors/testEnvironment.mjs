// Test-only subprocess environment: allow known OS keys, replace every config
// root and never inherit API tokens, proxy credentials, CLI homes or NODE_OPTIONS.
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export async function connectionTestEnvironment(root) {
  const home = path.join(root, 'home'), bin = path.join(root, 'bin'), temp = path.join(root, 'tmp')
  await Promise.all([mkdir(home, { recursive: true }), mkdir(bin, { recursive: true }), mkdir(temp, { recursive: true })])
  const env = Object.fromEntries(['SystemRoot', 'WINDIR', '__CF_USER_TEXT_ENCODING'].filter((key) => process.env[key]).map((key) => [key, process.env[key]]))
  Object.assign(env, {
    HOME: home, PATH: `${bin}:/usr/bin:/bin`,
    LANG: 'en_US.UTF-8', TMPDIR: temp, TMP: temp, TEMP: temp,
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_CACHE_HOME: path.join(home, '.cache'), XDG_STATE_HOME: path.join(home, '.local/state'),
    OPENBOT_DATA_DIR: path.join(root, 'data'),
    CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    GH_CONFIG_DIR: path.join(home, '.config/gh'), GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1'
  })
  const shell = path.join(root, 'isolated-shell')
  // A fixed shell script avoids sourcing the user's real login shell files.
  await writeFile(shell, '#!/bin/sh\nprintf "__openbot_env__\\n"\n/usr/bin/env\n', { mode: 0o700 })
  env.SHELL = shell
  return env
}
