import type { ReactNode } from 'react'
import { IconSpinner, IconWarning } from './Icons'
import './StartupScreen.css'

interface StartupScreenProps {
  error: string | null
}

/** Shown while the first snapshot loads, or when the bridge is missing. */
export function StartupScreen({ error }: StartupScreenProps): ReactNode {
  return (
    <div className="ob-startup">
      <div className="ob-startup-drag" />
      <div className="ob-startup-card">
        <span className="ob-startup-brand">BlinkyBot</span>
        {error ? (
          <>
            <p className="ob-startup-error">
              <IconWarning size={13} />
              {error}
            </p>
            <button type="button" className="ob-btn ob-btn-sm" onClick={() => window.location.reload()}>
              Reload
            </button>
          </>
        ) : (
          <p className="ob-startup-loading">
            <IconSpinner size={13} />
            Starting up…
          </p>
        )}
      </div>
    </div>
  )
}
