import type { Skill } from '../../../shared/types'
import type { SkillBulkSyncResult } from '../../../shared/skills'
import type { SkillRuntimeCheck, SkillVerificationReport } from '../../../main/skills/runtime'
import { bridge, errText } from './bridge'
import { store } from './core'

/**
 * Skills available to bots.
 *
 * The CLIs load skills themselves; OpenBOT only discovers what is installed and
 * records which ones a bot may use. Because each CLI reads only its own
 * directory plus the shared one, the list a bot can actually see depends on its
 * backend — `loadSkillsFor` is what the editor should use, not the full list.
 */
type SkillsApi = {
  list?: (cwd?: string) => Promise<Skill[]>
  refresh?: (cwd?: string) => Promise<Skill[]>
  forBackend?: (backendId: string, cwd?: string) => Promise<Skill[]>
  install?: (sourcePath: string, opts?: { overwrite?: boolean }) => Promise<unknown>
  uninstall?: (id: string) => Promise<unknown>
  syncExisting?: () => Promise<SkillBulkSyncResult & Partial<SkillVerificationReport>>
}

/** Resolved per call: an older preload simply has no skills namespace. */
function api(): SkillsApi | null {
  const surface = (bridge() as unknown as { skills?: SkillsApi }).skills
  return surface ?? null
}

export function skillsReady(): boolean {
  return api() !== null
}

export async function loadSkills(refresh = false): Promise<void> {
  const skills = api()
  if (!skills?.list) return
  store.patch({ skillsLoading: true })
  try {
    const list = refresh && skills.refresh ? await skills.refresh() : await skills.list()
    store.patch({ skills: list, skillsLoading: false, skillsError: null })
  } catch (e) {
    store.patch({ skillsLoading: false, skillsError: errText(e) })
  }
}

/** Only what this backend's CLI can actually see, deduped by preference. */
export async function loadSkillsFor(backendId: string): Promise<Skill[]> {
  const skills = api()
  if (!skills?.forBackend || !backendId) return []
  try {
    return await skills.forBackend(backendId)
  } catch (e) {
    store.toast(errText(e), 'error')
    return []
  }
}

/** Copy a folder into the shared skills directory. */
export async function installSkill(overwrite = false): Promise<SkillRuntimeCheck[]> {
  const skills = api()
  if (!skills?.install) return []
  const dir = await bridge().dialog.pickDirectory()
  if (!dir) return []
  try {
    const result = (await skills.install(dir, { overwrite })) as import('../../../shared/skills').SkillInstallResult & Partial<SkillVerificationReport>
    if (result?.ok) {
      const issues = (result.sync ?? []).filter((entry) => entry.status === 'conflict' || entry.status === 'error')
      const linked = (result.sync ?? []).filter((entry) => entry.status === 'linked' || entry.status === 'existing').length
      const zh = store.getState().settings?.language === 'zh-CN'
      store.toast(issues.length
        ? (zh ? `技能已安装，以下目录未同步：${issues.map((entry) => `${entry.agent}（${entry.status === 'conflict' ? '同名文件' : entry.detail ?? '错误'}）`).join('、')}。已有文件未被覆盖。` : `Skill installed, but these directories were not synced: ${issues.map((entry) => `${entry.agent} (${entry.status === 'conflict' ? 'name conflict' : entry.detail ?? 'error'})`).join(', ')}. Existing files were preserved.`)
        : (zh ? `技能已安装，已连接 ${linked} 个 Agent 目录；运行时加载仍取决于对应 Agent。` : `Skill installed and linked to ${linked} agent directories; runtime loading depends on each agent.`), issues.length ? 'error' : 'info')
      await loadSkills(true)
      return result.verification ?? []
    } else {
      store.toast(result?.error ?? 'That folder could not be installed as a skill.', 'error')
    }
  } catch (e) {
    store.toast(errText(e), 'error')
  }
  return []
}

export async function uninstallSkill(id: string): Promise<SkillRuntimeCheck[]> {
  const skills = api()
  if (!skills?.uninstall) return []
  try {
    const result = (await skills.uninstall(id)) as { ok?: boolean; error?: string } & Partial<SkillVerificationReport>
    if (result?.ok) await loadSkills(true)
    else store.toast(result?.error ?? 'That skill could not be removed.', 'error')
    return result.verification ?? []
  } catch (e) {
    store.toast(errText(e), 'error')
  }
  return []
}

export async function syncExistingSkills(): Promise<SkillRuntimeCheck[]> {
  const skills = api()
  if (!skills?.syncExisting) return []
  try {
    const report = await skills.syncExisting()
    if (!report.ok) { store.toast(report.error ?? 'Could not sync skills.', 'error'); return [] }
    const zh = store.getState().settings?.language === 'zh-CN'
    const issueNames = report.issues.slice(0, 3).map((issue) => `${issue.skill} / ${issue.agent}`).join('、')
    const detail = report.issues.length ? (zh ? `；${report.issues.length} 处冲突或错误：${issueNames}` : `; ${report.issues.length} conflicts or errors: ${issueNames}`) : ''
    store.toast(zh ? `已检查 ${report.skills} 个共享技能，连接 ${report.linked} 个目录${detail}。` : `Checked ${report.skills} shared skills and linked ${report.linked} directories${detail}.`, report.issues.length ? 'error' : 'info')
    await loadSkills(true)
    return report.verification ?? []
  } catch (error) { store.toast(errText(error), 'error') }
  return []
}
