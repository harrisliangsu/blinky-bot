/**
 * IPC for `OpenBotApi.skills`.
 *
 * Skills are executed by the agent CLIs themselves, not by us — this surface
 * discovers installed skills, manages the shared copy and creates owned links
 * in available local Agent directories. Native loading is host-dependent.
 */

import type { Skill, SkillInstallResult, SkillUninstallResult } from '../../shared/types'
import type { SkillBulkSyncResult } from '../../shared/skills'
import {
  installSkill,
  listSkills,
  syncExistingSkills,
  skillsFor,
  uninstallSkill
} from '../skills'
import { sweepStaleSkillInstalls } from '../skills/install'
import { CHANNELS } from './channels'
import { emptyArray, handle } from './handler'
import { asAbsolutePath, asId, asString } from './validate'

/**
 * A cwd is optional: it only adds project-local skills to the scan.
 *
 * It reaches us from a session, whose working directory can only have been set
 * from the native directory picker — so an absolute path is the sole shape
 * that can legitimately arrive. Every neighbouring channel validates the same
 * way; leaving this one open let the renderer walk it around the filesystem
 * and read back what each directory contains. An unusable value degrades to
 * the global skill set rather than emptying the list.
 */
function cwdOf(raw: unknown): { cwd?: string } {
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  try {
    return { cwd: asAbsolutePath(raw) }
  } catch {
    console.warn('[openbot/ipc] ignoring skills cwd that is not an absolute path')
    return {}
  }
}

export function registerSkillIpc(): void {
  // Startup housekeeping, off the critical path: a crash during an install
  // leaves hidden folders in the shared directory that discovery ignores and
  // nothing ever removed — and, in one case, the only surviving copy of a skill
  // that was being replaced. Registration is the one thing here that runs once
  // per launch, so it hangs off that.
  void sweepStaleSkillInstalls().catch((error) =>
    console.warn('[openbot/skills] stale install sweep failed', error)
  )

  handle<Skill[]>(CHANNELS.skillsList, ([cwd]) => listSkills(cwdOf(cwd)), emptyArray)

  handle<Skill[]>(
    CHANNELS.skillsRefresh,
    ([cwd]) => listSkills({ ...cwdOf(cwd), refresh: true }),
    emptyArray
  )

  handle<Skill[]>(
    CHANNELS.skillsFor,
    ([backendId, cwd]) => skillsFor(asString(backendId), cwdOf(cwd)),
    emptyArray
  )

  handle<SkillInstallResult>(
    CHANNELS.skillsInstall,
    // The folder comes from the native directory picker, exactly like the cwd
    // above, so an absolute path is the only shape that can legitimately
    // arrive. `installSkill` contains itself regardless; this is the border
    // being consistent with every neighbouring channel.
    ([sourcePath, opts]) =>
      installSkill(asAbsolutePath(sourcePath), {
        overwrite: typeof opts === 'object' && opts !== null && 'overwrite' in opts
          ? (opts as { overwrite?: unknown }).overwrite === true
          : false
      }),
    () => ({ ok: false, error: 'The skill could not be installed.' })
  )

  handle<SkillUninstallResult>(
    CHANNELS.skillsUninstall,
    ([id]) => uninstallSkill(asId(id)),
    () => ({ ok: false, error: 'The skill could not be removed.' })
  )
  handle<SkillBulkSyncResult>(CHANNELS.skillsSyncExisting, () => syncExistingSkills(), () => ({ ok: false, skills: 0, linked: 0, unavailable: 0, issues: [], error: 'Skills could not be synchronized.' }))
}
