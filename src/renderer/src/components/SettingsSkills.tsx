import { forwardRef, useEffect, useImperativeHandle, useMemo, useState, type ReactNode } from 'react'
import { SKILL_ORIGIN_LABELS } from '../../../shared/skills'
import { groupSkills } from '../lib/toolSync'
import { resolveSettingsLang } from '../lib/settingsCopy'
import { useSettingsCopy } from '../lib/useSettingsCopy'
import { installSkill, loadSkills, skillsReady, syncExistingSkills, uninstallSkill, useAppState } from '../state'
import { IconPlus, IconTrash } from './Icons'
import type { SkillRuntimeCheck } from '../../../main/skills/runtime'
import { SkillRuntimeResults } from './SkillRuntimeResults'

export interface SkillsHandle {
  sync(): void
  updateFromFolder(): void
  install(): void
}

/**
 * Skills installed on this Mac, grouped by name.
 *
 * The list is the shared folder plus whatever the local CLIs already have.
 * There is no preset catalog and no per-Bot assignment.
 */
export const SettingsSkills = forwardRef<SkillsHandle, { toolbar?: boolean }>(function SettingsSkills({ toolbar = true }, ref): ReactNode {
  const copy = useSettingsCopy().tools
  const { skills, skillsLoading, skillsError, settings } = useAppState()
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(20)
  const [syncing, setSyncing] = useState(false)
  const [checks, setChecks] = useState<SkillRuntimeCheck[]>([])
  async function mutate(run: () => Promise<SkillRuntimeCheck[]>): Promise<void> {
    setSyncing(true); setChecks([])
    try { setChecks(await run()) } finally { setSyncing(false) }
  }
  useImperativeHandle(ref, () => ({
    sync: () => void mutate(syncExistingSkills),
    updateFromFolder: () => void mutate(() => installSkill(true)),
    install: () => void mutate(() => installSkill())
  }), [])
  const lang = resolveSettingsLang(settings?.language, typeof navigator === 'undefined' ? 'zh-CN' : navigator.language)
  const zh = lang === 'zh-CN'
  const matches = useMemo(() => {
    const term = query.trim().toLocaleLowerCase()
    return term ? skills.filter((skill) => `${skill.name} ${skill.description} ${skill.origin} ${skill.path}`.toLocaleLowerCase().includes(term)) : skills
  }, [skills, query])
  const groups = useMemo(() => groupSkills(matches), [matches])
  const idCounts = useMemo(() => {
    const counts = new Map<string, number>()
    skills.forEach((skill) => counts.set(skill.id, (counts.get(skill.id) ?? 0) + 1))
    return counts
  }, [skills])

  useEffect(() => {
    if (!skillsReady()) return
    void loadSkills()
  }, [])

  if (!skillsReady()) return null

  return (
    <section className="ob-settings-section" data-skills="">
      {toolbar ? <div className="ob-skill-toolbar">
        <h3 className="ob-label">{copy.skillsTitle}</h3>
        <button type="button" className="ob-btn ob-btn-sm" disabled={syncing} onClick={() => void mutate(syncExistingSkills)}>
          {syncing ? (zh ? '同步与验证中…' : 'Syncing and verifying…') : (zh ? '同步并验证' : 'Sync and verify')}
        </button>
        <button type="button" className="ob-btn ob-btn-sm" disabled={syncing} onClick={() => void mutate(() => installSkill(true))}>
          {zh ? '从文件夹更新' : 'Update from folder'}
        </button>
        <button type="button" className="ob-btn ob-btn-sm ob-btn-primary" disabled={syncing} onClick={() => void mutate(() => installSkill())}>
          <IconPlus size={12} />
          {copy.skillsInstall}
        </button>
      </div> : null}
      {toolbar ? <p className="ob-hint">{copy.skillsIntro}</p> : null}
      <SkillRuntimeResults checks={checks} zh={zh} />
      {skillsError ? (
        <p className="ob-notice ob-notice-error" role="alert">
          {skillsError}
        </p>
      ) : null}
      {skillsLoading && skills.length === 0 ? <p className="ob-hint">{copy.skillsLoading}</p> : null}
      {!skillsLoading && !skillsError && skills.length === 0 ? <p className="ob-hint">{copy.skillsEmpty}</p> : null}
      {skills.length > 0 ? (
        <div className="ob-skill-search">
          <input
            type="search"
            className="ob-input"
            aria-label={zh ? '搜索技能' : 'Search skills'}
            placeholder={zh ? '搜索名称、描述或来源' : 'Search name, description, or source'}
            value={query}
            onChange={(event) => { setQuery(event.target.value); setLimit(20) }}
          />
          <span className="ob-hint" role="status">{zh ? `${groups.length} 项` : `${groups.length} skills`}</span>
        </div>
      ) : null}
      {query.trim() && groups.length === 0 ? <p className="ob-hint">{zh ? '没有找到匹配的技能。' : 'No skills match your search.'}</p> : null}
      <ul className="ob-skill-list">
        {groups.slice(0, limit).map((group) => {
          const shared = group.sources.find((skill) => skill.shared)
          const duplicated = group.sources.some((skill) => (idCounts.get(skill.id) ?? 0) > 1)
          return <li key={group.name} className="ob-skill-row" data-skill={group.name}>
            <div className="ob-skill-text">
              <div className="ob-skill-title">
                <span className="ob-skill-name">{group.name}</span>
                {group.sources.map((skill) => <span key={skill.id} className="ob-pill">{skill.shared && zh ? '共享' : SKILL_ORIGIN_LABELS[skill.origin]}</span>)}
              </div>
              {group.description ? <details className="ob-skill-detail" data-skill-description=""><summary>{zh ? '描述' : 'Description'}</summary><p>{group.description}</p></details> : null}
              {duplicated ? <p className="ob-hint">{zh ? '名称重复，请在共享目录中确认后再移除。' : 'Duplicate name; check the shared folder before removing.'}</p> : null}
            </div>
            {shared ? (
              <button
                type="button"
                className="ob-icon-btn"
                aria-label={`${copy.skillsRemove} ${group.name}`}
                disabled={syncing || duplicated}
                onClick={() => void mutate(() => uninstallSkill(shared.id))}
              >
                <IconTrash size={12} />
              </button>
            ) : null}
          </li>
        })}
      </ul>
      {groups.length > limit ? <button type="button" className="ob-btn ob-btn-sm ob-skill-more" onClick={() => setLimit((value) => value + 20)}>{zh ? `显示更多（剩余 ${groups.length - limit} 项）` : `Show more (${groups.length - limit} remaining)`}</button> : null}
    </section>
  )
})
