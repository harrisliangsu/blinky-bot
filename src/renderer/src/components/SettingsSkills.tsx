import { useEffect, type ReactNode } from 'react'
import { useSettingsCopy } from '../lib/useSettingsCopy'
import { installSkill, loadSkills, skillsReady, uninstallSkill, useAppState } from '../state'
import { IconPlus, IconTrash } from './Icons'

/**
 * Skills installed on this Mac.
 *
 * Assignment stays on each Bot. This list is the shared folder plus whatever
 * the CLIs already have, with no preset catalog.
 */
export function SettingsSkills(): ReactNode {
  const copy = useSettingsCopy().tools
  const { skills, skillsLoading, skillsError } = useAppState()

  useEffect(() => {
    if (!skillsReady()) return
    void loadSkills()
  }, [])

  if (!skillsReady()) return null

  return (
    <section className="ob-settings-section" data-skills="">
      <header className="ob-settings-head">
        <h3 className="ob-label">{copy.skillsTitle}</h3>
        <button type="button" className="ob-btn ob-btn-sm" onClick={() => void installSkill()}>
          <IconPlus size={12} />
          {copy.skillsInstall}
        </button>
      </header>
      <p className="ob-hint">{copy.skillsIntro}</p>
      {skillsError ? (
        <p className="ob-notice ob-notice-error" role="alert">
          {skillsError}
        </p>
      ) : null}
      {skillsLoading && skills.length === 0 ? <p className="ob-hint">{copy.skillsLoading}</p> : null}
      {!skillsLoading && !skillsError && skills.length === 0 ? <p className="ob-hint">{copy.skillsEmpty}</p> : null}
      <ul className="ob-skill-list">
        {skills.map((skill) => (
          <li key={skill.id} className="ob-skill-row">
            <div className="ob-skill-text">
              <span className="ob-skill-name">{skill.name}</span>
              {skill.shared ? <span className="ob-pill">{copy.skillsShared}</span> : null}
              {skill.description ? <p className="ob-hint ob-skill-desc">{skill.description}</p> : null}
            </div>
            {skill.shared ? (
              <button
                type="button"
                className="ob-icon-btn"
                aria-label={`${copy.skillsRemove} ${skill.name}`}
                onClick={() => void uninstallSkill(skill.id)}
              >
                <IconTrash size={12} />
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  )
}
