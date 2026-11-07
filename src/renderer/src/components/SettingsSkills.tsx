import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { SKILL_ORIGIN_LABELS } from '../../../shared/skills'
import { resolveSettingsLang } from '../lib/settingsCopy'
import { useSettingsCopy } from '../lib/useSettingsCopy'
import { installSkill, loadSkills, skillsReady, syncExistingSkills, uninstallSkill, useAppState } from '../state'
import { IconPlus, IconTrash } from './Icons'
import type { SkillRuntimeCheck } from '../../../main/skills/runtime'
import { SkillRuntimeResults } from './SkillRuntimeResults'

/**
 * Skills installed on this Mac.
 *
 * Assignment stays on each Bot. This list is the shared folder plus whatever
 * the CLIs already have, with no preset catalog.
 */
export function SettingsSkills(): ReactNode {
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
  const lang = resolveSettingsLang(settings?.language, typeof navigator === 'undefined' ? 'zh-CN' : navigator.language)
  const zh = lang === 'zh-CN'
  const matches = useMemo(() => {
    const term = query.trim().toLocaleLowerCase()
    return term ? skills.filter((skill) => `${skill.name} ${skill.description} ${skill.origin} ${skill.path}`.toLocaleLowerCase().includes(term)) : skills
  }, [skills, query])
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
      <header className="ob-settings-head">
        <h3 className="ob-label">{copy.skillsTitle}</h3>
        <button type="button" className="ob-btn ob-btn-sm" disabled={syncing} onClick={() => void mutate(syncExistingSkills)}>
          {syncing ? (zh ? '同步与验证中…' : 'Syncing and verifying…') : (zh ? '同步并验证' : 'Sync and verify')}
        </button>
        <button type="button" className="ob-btn ob-btn-sm" disabled={syncing} onClick={() => void mutate(() => installSkill(true))}>
          {zh ? '从文件夹更新' : 'Update from folder'}
        </button>
        <button type="button" className="ob-btn ob-btn-sm" disabled={syncing} onClick={() => void mutate(() => installSkill())}>
          <IconPlus size={12} />
          {copy.skillsInstall}
        </button>
      </header>
      <p className="ob-hint">{copy.skillsIntro}</p>
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
          <span className="ob-hint" role="status">{zh ? `${matches.length} 项` : `${matches.length} skills`}</span>
        </div>
      ) : null}
      {query.trim() && matches.length === 0 ? <p className="ob-hint">{zh ? '没有找到匹配的技能。' : 'No skills match your search.'}</p> : null}
      <ul className="ob-skill-list">
        {matches.slice(0, limit).map((skill) => (
          <li key={`${skill.id}:${skill.path}`} className="ob-skill-row">
            <div className="ob-skill-text">
              <div className="ob-skill-title"><span className="ob-skill-name">{skill.name}</span><span className="ob-pill">{skill.shared && zh ? '共享' : SKILL_ORIGIN_LABELS[skill.origin]}</span></div>
              <p className="ob-skill-path" title={skill.path}>{skill.path}</p>
              {skill.description ? <p className="ob-hint ob-skill-desc">{skill.description.length > 160 ? `${skill.description.slice(0, 160)}…` : skill.description}</p> : null}
              {skill.description.length > 160 ? <details className="ob-skill-detail"><summary>{zh ? '完整描述' : 'Full description'}</summary><p>{skill.description}</p></details> : null}
              {skill.shared && (idCounts.get(skill.id) ?? 0) > 1 ? <p className="ob-hint">{zh ? '名称重复，请在共享目录中确认后再移除。' : 'Duplicate name; check the shared folder before removing.'}</p> : null}
            </div>
            {skill.shared ? (
              <button
                type="button"
                className="ob-icon-btn"
                aria-label={`${copy.skillsRemove} ${skill.name}`}
                disabled={syncing || (idCounts.get(skill.id) ?? 0) > 1}
                onClick={() => void mutate(() => uninstallSkill(skill.id))}
              >
                <IconTrash size={12} />
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {matches.length > limit ? <button type="button" className="ob-btn ob-btn-sm ob-skill-more" onClick={() => setLimit((value) => value + 20)}>{zh ? `显示更多（剩余 ${matches.length - limit} 项）` : `Show more (${matches.length - limit} remaining)`}</button> : null}
    </section>
  )
}
