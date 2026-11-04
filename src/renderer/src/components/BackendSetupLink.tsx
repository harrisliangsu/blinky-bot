import type { ReactNode } from 'react'
import { isBackendSetupMessage } from '../../../shared/backendPrompt'
import { openSettings } from '../lib/settingsNavigation'

/** Opens Settings on the Backends section. Renders nothing for other errors. */
export function BackendSetupLink({ text }: { text: string }): ReactNode {
  if (!isBackendSetupMessage(text)) return null
  return (
    <button type="button" className="ob-btn ob-btn-sm" onClick={() => openSettings('backends')}>
      Open Settings → Backends
    </button>
  )
}
