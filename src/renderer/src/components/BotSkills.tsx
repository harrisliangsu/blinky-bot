import { useEffect, useState, type ReactNode } from 'react'
import type { Skill } from '../../../shared/types'
import { installSkill, loadSkillsFor, skillsReady, useAppState } from '../state'
import { IconPlus } from './Icons'
import { useBotChinese } from './BotUiLanguage'
import './BotSkills.css'

interface BotSkillsProps {
  backendId: string
  selected: string[]
  onChange: (skills: string[]) => void
}

/**
 * Skills a bot may use.
 *
 * Only the ones this bot's CLI can actually reach are offered: each agent reads
 * its own directory plus the shared one, so listing everything would let the
 * user assign a skill that silently does nothing. Anything already assigned but
 * now unreachable is still shown, flagged, so it can be removed rather than
 * lingering invisibly.
 */
export function BotSkills({ backendId, selected, onChange }: BotSkillsProps): ReactNode {
  const zh = useBotChinese()
  const { skills: all } = useAppState()
  const [visible, setVisible] = useState<Skill[]>([])
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')

  useEffect(() => {
    let live = true
    if (!backendId) {
      setVisible([])
      /*
       * Clearing here is what stops a permanent spinner. Switching to a bot
       * with no backend yet took this early return, which never cleared the
       * flag the previous run raised — and that run's `setLoading(false)` was
       * skipped too, because this cleanup had already flipped `live`. The panel
       * then sat on "Looking for skills…" for good, hiding the message that
       * says no skills are reachable.
       */
      setLoading(false)
      return
    }
    setLoading(true)
    void loadSkillsFor(backendId).then((list) => {
      if (!live) return
      setVisible(list)
      setLoading(false)
    })
    return () => {
      live = false
      // The answer this run is waiting on will be ignored, so its flag must not
      // outlive it either.
      setLoading(false)
    }
  }, [backendId, all.length])

  if (!skillsReady()) return null

  const reachable = new Set(visible.map((s) => s.id))
  const orphans = selected.filter((id) => !reachable.has(id))
  const needle = query.trim().toLocaleLowerCase()
  const shown = needle ? visible.filter((skill) => `${skill.name} ${skill.description ?? ''}`.toLocaleLowerCase().includes(needle)) : visible

  const toggle = (id: string): void => {
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id])
  }

  return (
    <div className="ob-field">
      <div className="ob-bot-skills-head">
        <span className="ob-label">{zh ? '可用技能' : 'Available skills'}</span>
        <button
          type="button"
          className="ob-btn ob-btn-sm"
          onClick={() => void installSkill()}
          title={zh ? '安装技能到共享目录' : 'Install a skill folder in the shared directory'}
        >
          <IconPlus size={11} />
          {zh ? '安装' : 'Install'}
        </button>
      </div>
      <p className="ob-hint">
        {zh ? '为此 Bot 选择技能；安装的技能保存在共享目录。' : 'Choose skills for this bot. Installed skills are saved in the shared folder.'}
      </p>

      {loading ? <p className="ob-hint">{zh ? '正在查找技能…' : 'Looking for skills…'}</p> : null}

      {!loading && visible.length > 0 ? (
        <input className="ob-input" aria-label={zh ? '搜索技能' : 'Search skills'} placeholder={zh ? '搜索技能…' : 'Search skills…'} value={query} onChange={(event) => setQuery(event.target.value)} />
      ) : null}

      {!loading && visible.length === 0 ? (
        <p className="ob-hint">
          {zh ? '没有找到当前执行器可用的技能。' : 'No skills are available to this agent.'}
        </p>
      ) : null}

      {!loading && needle && shown.length === 0 ? <p className="ob-hint">{zh ? '没有匹配的技能。' : 'No matching skills.'}</p> : null}
      {shown.map((skill) => (
        <label key={skill.id} className="ob-check ob-bot-skill">
          <input
            type="checkbox"
            checked={selected.includes(skill.id)}
            onChange={() => toggle(skill.id)}
          />
          <span>
            <span className="ob-bot-skill-name">{skill.name}</span>
            {skill.shared ? <span className="ob-pill">{zh ? '共享' : 'shared'}</span> : null}
            {skill.description ? (
              <span className="ob-hint ob-bot-skill-desc">{skill.description}</span>
            ) : null}
          </span>
        </label>
      ))}

      {orphans.length > 0 ? (
        <p className="ob-notice ob-notice-error" role="status">
          {zh ? `${orphans.length} 个已选技能对当前执行器不可用（${orphans.join('、')}）。可以移除：` : `${orphans.length} assigned skill${orphans.length === 1 ? '' : 's'} cannot be reached by this agent (${orphans.join(', ')}). Remove:`}{' '}
          {orphans.map((id) => (
            <button key={id} type="button" className="ob-btn ob-btn-sm" onClick={() => toggle(id)}>
              {zh ? `移除 ${id}` : `Remove ${id}`}
            </button>
          ))}
        </p>
      ) : null}
    </div>
  )
}
