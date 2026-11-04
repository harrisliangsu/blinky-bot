import { useEffect, useState, type ReactNode } from 'react'
import type { AppStatus } from '../../../shared/apps'
import type { Settings } from '../../../shared/types'
import { useSettingsCopy } from '../lib/useSettingsCopy'
import { store } from '../state'
import { SettingsMcp } from './SettingsMcp'
import './SettingsApps.css'

/** GitHub, Git, and Gmail. One connection, shared by every Bot. */
export function SettingsApps({ settings }: { settings: Settings }): ReactNode {
  const copy = useSettingsCopy().apps
  const [rows, setRows] = useState<AppStatus[]>([])
  const [gitName, setGitName] = useState('')
  const [gitEmail, setGitEmail] = useState('')
  const [busy, setBusy] = useState(false)

  const load = (): void => {
    void window.openbot.apps.status().then(setRows).catch(() => setRows([]))
  }

  useEffect(() => {
    load()
    window.addEventListener('focus', load)
    return () => window.removeEventListener('focus', load)
  }, [])

  const row = (id: AppStatus['id']): AppStatus | undefined => rows.find((item) => item.id === id)
  const label = (status: AppStatus['status'] | undefined): string => {
    if (status === 'connected') return copy.connected
    if (status === 'unavailable') return copy.unavailable
    if (status === 'pending') return copy.pending
    return copy.disconnected
  }

  const github = row('github')
  const git = row('git')
  const gmail = row('gmail')

  return (
    <div className="ob-set-stack" data-apps="">
      <section className="ob-set-card">
        <h3>{copy.title}</h3>
        <p className="ob-hint">{copy.intro}</p>
        <p className="ob-hint">{copy.shared}</p>
        <p className="ob-hint">{copy.confirm}</p>
        <div className="ob-apps-toolbar">
          <button type="button" className="ob-btn ob-btn-sm" onClick={load}>
            {copy.refresh}
          </button>
        </div>
      </section>

      <section className="ob-set-card" data-app="github">
        <h3>{copy.githubTitle}</h3>
        <p className="ob-hint">{copy.githubHint}</p>
        <p className="ob-set-value">
          {label(github?.status)}
          {github?.account ? ` · ${github.account}` : ''}
        </p>
        {github?.status === 'unavailable' ? <p className="ob-hint">{copy.githubMissing}</p> : null}
        <button
          type="button"
          className="ob-btn ob-btn-sm"
          data-connect="github"
          disabled={busy || github?.status === 'unavailable'}
          onClick={() => {
            setBusy(true)
            void window.openbot.apps
              .connectGitHub()
              .then((result) => {
                if (!result.started) store.toast(copy.githubLoginFailed, 'error')
              })
              .finally(() => {
                setBusy(false)
                load()
              })
          }}
        >
          {copy.connect}
        </button>
      </section>

      <section className="ob-set-card" data-app="git">
        <h3>{copy.gitTitle}</h3>
        <p className="ob-hint">{copy.gitHint}</p>
        <p className="ob-set-value">
          {label(git?.status)}
          {git?.account ? ` · ${git.account}` : ''}
        </p>
        {git?.status === 'unavailable' ? <p className="ob-hint">{copy.gitMissing}</p> : null}
        {git?.detail === 'invalid' ? <p className="ob-hint">{copy.gitInvalid}</p> : null}
        {git?.detail === 'failed' ? <p className="ob-hint">{copy.gitFailed}</p> : null}
        <div className="ob-apps-git">
          <input
            className="ob-input"
            aria-label={copy.gitName}
            placeholder={copy.gitName}
            value={gitName}
            onChange={(e) => setGitName(e.target.value)}
          />
          <input
            className="ob-input"
            aria-label={copy.gitEmail}
            placeholder={copy.gitEmail}
            value={gitEmail}
            onChange={(e) => setGitEmail(e.target.value)}
          />
          <button
            type="button"
            className="ob-btn ob-btn-sm"
            data-connect="git"
            disabled={busy || git?.status === 'unavailable'}
            onClick={() => {
              setBusy(true)
              void window.openbot.apps
                .connectGit(gitName, gitEmail)
                .then((next) => setRows((current) => current.map((item) => (item.id === 'git' ? next : item))))
                .finally(() => setBusy(false))
            }}
          >
            {copy.gitSave}
          </button>
        </div>
      </section>

      <section className="ob-set-card" data-app="gmail">
        <h3>{copy.gmailTitle}</h3>
        <p className="ob-hint">{copy.gmailHint}</p>
        <p className="ob-set-value">{label(gmail?.status)}</p>
        {gmail?.status === 'pending' ? <p className="ob-hint">{copy.gmailPending}</p> : null}
        <button
          type="button"
          className="ob-btn ob-btn-sm"
          data-connect="gmail"
          disabled={busy || gmail?.status === 'pending'}
          onClick={() => {
            setBusy(true)
            void window.openbot.apps
              .requestGmail()
              .then((next) => setRows((current) => current.map((item) => (item.id === 'gmail' ? next : item))))
              .finally(() => setBusy(false))
          }}
        >
          {copy.connect}
        </button>
      </section>

      <details className="ob-apps-advanced">
        <summary>{copy.advanced}</summary>
        <p className="ob-hint">{copy.advancedHint}</p>
        <SettingsMcp settings={settings} hideCatalog />
      </details>
    </div>
  )
}
