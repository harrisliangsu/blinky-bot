/**
 * Installing and removing skills.
 *
 * An install copies a folder the user picked into `~/.agents/skills/<name>` —
 * the shared directory. The copy lands in a hidden staging folder first and is renamed
 * into place, so a failed copy never leaves half a skill behind. Replacing an
 * installed skill renames the old one aside first and only deletes it once the
 * new one has landed, so a crash mid-install always leaves one of the two
 * recoverable; `sweepStaleSkillInstalls` finishes the job on the next launch.
 *
 * Removal only ever touches `~/.agents/skills`. The CLIs' own directories are
 * theirs: we did not put those skills there and we do not delete them.
 *
 * Containment rules: the destination is verified to sit inside the shared
 * directory after `realpath`; the copy itself, with its symlink and size
 * guards, lives in `copy.ts`.
 */

import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, realpath, rename, rm, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import {
  SHARED_SKILL_ORIGIN,
  SKILL_FILE,
  isSkillName,
  parseSkillId,
  type SkillInstallOptions,
  type SkillInstallResult,
  type SkillUninstallResult
} from '../../shared/skills'
import { copyTree, isInside } from './copy'
import { readSkill, scanRoot } from './discover'
import { readSkillHead } from './frontmatter'
import { sharedSkillsDir } from './roots'

export async function installSkill(
  sourcePath: string,
  opts: SkillInstallOptions = {}
): Promise<SkillInstallResult> {
  const picked = expandHome((sourcePath ?? '').trim())
  if (!picked) return fail('Pick the folder that contains the skill.')

  const absolute = resolve(picked)
  let source: string
  try {
    source = await realpath(absolute)
    if (!(await stat(source)).isDirectory()) return fail(`${absolute} is not a folder.`)
  } catch {
    return fail(`There is no folder at ${absolute}.`)
  }

  const file = join(source, SKILL_FILE)
  try {
    if (!(await stat(file)).isFile()) throw new Error('not a file')
  } catch {
    return fail(
      `${absolute} is not a skill: it has no ${SKILL_FILE} at the top level. ` +
        `Pick the folder that contains ${SKILL_FILE}.`
    )
  }

  const head = await readSkillHead(file)
  const name = installName(head?.fields.name, basename(source))
  if (!name) {
    return fail(
      `Could not work out a name for this skill. Give the folder a plain name ` +
        `(letters, digits, dashes) or set "name:" in ${SKILL_FILE}.`
    )
  }

  const shared = sharedSkillsDir()
  const dest = join(shared, name)
  if (!isInside(shared, dest) || basename(dest) !== name) {
    return fail(`"${name}" is not a usable skill folder name.`)
  }

  // Not yet created on a fresh machine, in which case the literal path is the
  // only thing to compare against.
  const realShared = await realpath(shared).catch(() => shared)
  if (isInside(realShared, source)) {
    return fail(`${absolute} is already in the shared skills directory — every CLI can see it.`)
  }
  if (isInside(source, realShared)) {
    return fail(
      `${absolute} contains the shared skills directory, so installing it would copy it into itself. ` +
        `Pick the skill's own folder, the one holding ${SKILL_FILE}.`
    )
  }

  const already = await exists(dest)
  if (already && !opts.overwrite) {
    return fail(
      `A skill named "${name}" is already installed at ${dest}. ` +
        `Install again with Replace to overwrite it, or rename the folder you are installing.`
    )
  }

  return writeSkill({ source, dest, shared, name, replacing: already })
}

interface WriteInput {
  source: string
  dest: string
  shared: string
  name: string
  replacing: boolean
}

/** Stage into a hidden sibling, then swap it into place. */
async function writeSkill(input: WriteInput): Promise<SkillInstallResult> {
  // Random, not timestamped: two installs started in the same millisecond must
  // not stage into — and then delete — each other's folder.
  const suffix = randomUUID().slice(0, 8)
  const staging = join(input.shared, `.${input.name}.installing-${suffix}`)
  const backup = join(input.shared, `.${input.name}.replaced-${suffix}`)
  let movedAside = false

  try {
    await mkdir(input.shared, { recursive: true })
    await rm(staging, { recursive: true, force: true })
    await copyTree(input.source, staging)

    if (input.replacing) {
      /*
       * Renamed aside, never deleted here.
       *
       * Deleting the old copy and then renaming the new one into place leaves a
       * window where the skill exists only under the hidden staging name, which
       * discovery skips as a dotfile — a crash inside that window deleted the
       * user's skill outright and left no visible trace of the replacement.
       * Two renames have no such window: one of the two names always holds a
       * complete skill.
       */
      await moveInside(input.shared, input.dest, backup)
      movedAside = true
    }
    await rename(staging, input.dest)
  } catch (error) {
    if (movedAside) {
      // The new copy never landed, so the old one goes back where it was.
      await rename(backup, input.dest).catch((restoreError) =>
        console.error('[openbot/skills] could not restore', input.dest, 'from', backup, restoreError)
      )
    }
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    return fail(`Could not install "${input.name}": ${message(error)}`)
  }

  if (movedAside) {
    await removeInside(input.shared, backup).catch((error) =>
      console.warn('[openbot/skills] replaced copy left behind at', backup, error)
    )
  }

  const skill = await readSkill(input.dest, input.name, {
    origin: SHARED_SKILL_ORIGIN,
    dir: input.shared,
    shared: true
  })
  if (!skill) return fail(`Installed "${input.name}" but could not read it back from ${input.dest}.`)
  return { ok: true, skill }
}

/** Remove a skill. Refuses anything that is not inside `~/.agents/skills`. */
export async function uninstallSkill(id: string): Promise<SkillUninstallResult> {
  const parsed = parseSkillId(id ?? '')
  if (!parsed) return { ok: false, error: `"${id}" is not a skill id.` }

  if (parsed.origin !== SHARED_SKILL_ORIGIN) {
    return {
      ok: false,
      error:
        `"${parsed.name}" lives in the ${parsed.origin} skills directory, which that tool manages. ` +
        `BlinkyBot only removes skills it installed in ${sharedSkillsDir()}.`
    }
  }

  const shared = sharedSkillsDir()
  const dest = await installedFolder(shared, id, parsed.name)
  if (!dest || !isInside(shared, dest) || dirname(dest) !== shared) {
    return { ok: false, error: `No skill named "${parsed.name}" is installed in ${shared}.` }
  }

  try {
    await removeInside(shared, dest)
  } catch (error) {
    return { ok: false, error: `Could not remove "${parsed.name}": ${message(error)}` }
  }
  return { ok: true }
}

/**
 * The folder a shared-directory id actually names.
 *
 * An id carries the skill's *declared* name, which need not match its folder
 * name, so the directory is scanned and matched by id rather than the path
 * being rebuilt from the name — rebuilding it can miss the skill the user
 * meant and land on a different folder that happens to be called that.
 */
async function installedFolder(shared: string, id: string, name: string): Promise<string | null> {
  const installed = await scanRoot({ origin: SHARED_SKILL_ORIGIN, dir: shared, shared: true })
  const match = installed.find((skill) => skill.id === id)
  if (match) return match.path

  // Present but not readable as a skill; still ours to remove.
  const byName = join(shared, name)
  const doc = await stat(join(byName, SKILL_FILE)).catch(() => null)
  return doc?.isFile() ? byName : null
}

/**
 * Rename `from` to `to`, both proven to be siblings directly inside `shared`.
 *
 * A symlink is moved as the link itself — `rename` never follows one — so an
 * entry pointing outside the shared directory is displaced, not chased.
 */
async function moveInside(shared: string, from: string, to: string): Promise<void> {
  const realShared = await realpath(shared)
  const parent = await realpath(dirname(from))
  if (!isInside(realShared, parent) || dirname(to) !== dirname(from)) {
    throw new Error(`${from} cannot be moved aside inside ${shared}`)
  }
  await rename(from, to)
}

/** `.<name>.installing-<id>` — a copy that never landed. */
const STAGING_NAME = /^\.(.+)\.installing-[0-9a-f]{8}$/
/** `.<name>.replaced-<id>` — the previous version of a replace-install. */
const BACKUP_NAME = /^\.(.+)\.replaced-[0-9a-f]{8}$/
/** Long enough that no live install — capped at 100 MB — is still working. */
const STALE_AFTER_MS = 60 * 60_000

/**
 * Finish or undo installs that a crash interrupted.
 *
 * Both hidden names are invisible to discovery, so whatever they hold is doing
 * nothing but taking up space — except in the one case that matters: a backup
 * with no skill at its real name is a replace-install that died between the two
 * renames, and the backup is then the user's only copy. That one is put back.
 * Everything else is removed once it is old enough to be certainly abandoned.
 */
export async function sweepStaleSkillInstalls(): Promise<void> {
  const shared = sharedSkillsDir()
  const entries = await readdir(shared).catch(() => [] as string[])
  const cutoff = Date.now() - STALE_AFTER_MS

  for (const entry of entries) {
    const backup = BACKUP_NAME.exec(entry)?.[1] ?? ''
    const path = join(shared, entry)
    if (backup) {
      const restored = join(shared, backup)
      if (!(await exists(restored))) {
        try {
          await moveInside(shared, path, restored)
          console.warn('[openbot/skills] restored an interrupted replace ->', restored)
        } catch (error) {
          console.warn('[openbot/skills] could not restore', restored, error)
        }
        continue
      }
    } else if (!STAGING_NAME.test(entry)) {
      continue
    }

    const info = await lstat(path).catch(() => null)
    if (!info || info.mtimeMs > cutoff) continue
    await removeInside(shared, path).catch((error) =>
      console.warn('[openbot/skills] could not remove a stale install folder', path, error)
    )
  }
}

/** Delete `target`, but only once it is proven to sit inside `shared`. */
async function removeInside(shared: string, target: string): Promise<void> {
  const realShared = await realpath(shared)
  const parent = await realpath(dirname(target))
  if (!isInside(realShared, parent)) throw new Error(`${target} is not inside ${shared}`)

  // A symlink is unlinked, never followed. Removing the link removes only the
  // entry in the shared directory; following it could remove the user's files.
  if ((await lstat(target)).isSymbolicLink()) {
    await unlink(target)
    return
  }

  const realTarget = await realpath(target)
  if (!isInside(realShared, realTarget) || realTarget === realShared) {
    throw new Error(`${target} resolves outside ${shared}`)
  }
  await rm(target, { recursive: true, force: true })
}

function installName(declared: string | undefined, folder: string): string | null {
  const candidate = (declared ?? '').trim()
  if (isSkillName(candidate)) return candidate
  if (isSkillName(folder)) return folder
  const slug = folder
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 128)
  return isSkillName(slug) ? slug : null
}

function expandHome(input: string): string {
  if (input === '~') return homedir()
  if (input.startsWith(`~${sep}`) || input.startsWith('~/')) return join(homedir(), input.slice(2))
  return input
}

async function exists(path: string): Promise<boolean> {
  return await lstat(path).then(
    () => true,
    () => false
  )
}

function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  // The staged folder could not be swapped in: another install of the same name
  // got there first. Raw errno text helps nobody.
  return /ENOTEMPTY|EEXIST/.test(text) ? 'another copy appeared while it was installing — try again' : text
}

function fail(error: string): SkillInstallResult {
  return { ok: false, error }
}
