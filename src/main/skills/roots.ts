/**
 * Where skills live on disk.
 *
 * Every path is derived from `os.homedir()` at call time — never captured at
 * module load and never hardcoded — so the table follows the user the app is
 * actually running as.
 *
 * User-level roots (verified layout):
 *   ~/.claude/skills            Claude Code
 *   ~/.config/opencode/skills   OpenCode  (XDG_CONFIG_HOME honoured)
 *   ~/.codex/skills             Codex
 *   ~/.kimi-code/skills         Kimi Code
 *   ~/.grok/skills              Grok
 *   ~/.pi/agent/skills          pi
 *   ~/.agents/skills            shared — every CLI reads this one
 *
 * Project-level roots are the same dot-directories inside the session's working
 * folder; they all report origin `project`, because that is how the CLIs treat
 * them: nearest wins, whichever CLI wrote them.
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { SHARED_SKILL_ORIGIN, type SkillOrigin } from '../../shared/skills'

export interface SkillRoot {
  origin: SkillOrigin
  /** Absolute directory that contains one folder per skill. */
  dir: string
  shared: boolean
}

function configHome(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  return xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.config')
}

/** The shared directory: install target and the only directory we may delete in. */
export function sharedSkillsDir(): string {
  return join(homedir(), '.agents', 'skills')
}

/** Every user-level root, shared one first. */
export function userSkillRoots(): SkillRoot[] {
  const home = homedir()
  return [
    { origin: SHARED_SKILL_ORIGIN, dir: sharedSkillsDir(), shared: true },
    { origin: 'claude', dir: join(home, '.claude', 'skills'), shared: false },
    { origin: 'opencode', dir: join(configHome(), 'opencode', 'skills'), shared: false },
    { origin: 'codex', dir: join(home, '.codex', 'skills'), shared: false },
    { origin: 'kimi', dir: join(home, '.kimi-code', 'skills'), shared: false },
    { origin: 'grok', dir: join(home, '.grok', 'skills'), shared: false },
    { origin: 'pi', dir: join(home, '.pi', 'agent', 'skills'), shared: false }
  ]
}

/**
 * Project-local roots for a working folder. `.agents/skills` there is shared in
 * the same sense as the user-level one — every CLI reads it — so it keeps the
 * `shared` flag even though its origin is `project`.
 */
export function projectSkillRoots(cwd: string): SkillRoot[] {
  if (!cwd || !isAbsolute(cwd)) return []
  const root = resolve(cwd)
  return [
    { origin: 'project', dir: join(root, '.agents', 'skills'), shared: true },
    { origin: 'project', dir: join(root, '.claude', 'skills'), shared: false },
    { origin: 'project', dir: join(root, '.opencode', 'skills'), shared: false },
    { origin: 'project', dir: join(root, '.codex', 'skills'), shared: false },
    { origin: 'project', dir: join(root, '.kimi-code', 'skills'), shared: false },
    { origin: 'project', dir: join(root, '.grok', 'skills'), shared: false },
    { origin: 'project', dir: join(root, '.pi', 'skills'), shared: false },
    { origin: 'project', dir: join(root, '.pi', 'agent', 'skills'), shared: false }
  ]
}

/** User roots, plus the project ones when a working folder is given. */
export function skillRoots(cwd?: string): SkillRoot[] {
  return [...userSkillRoots(), ...(cwd ? projectSkillRoots(cwd) : [])]
}
