import type { ReactNode } from 'react'
import { isBackendSetupMessage } from '../../../shared/backendPrompt'
import { openSettings } from '../lib/settingsNavigation'
import { useSettingsCopy } from '../lib/useSettingsCopy'

/** Opens Settings on Providers and local CLIs. Renders nothing for other errors. */
export function BackendSetupLink({ text }: { text: string }): ReactNode {
  const chat = useSettingsCopy().chat
  if (!isBackendSetupMessage(text)) return null
  return (
    <button type="button" className="ob-btn ob-btn-sm" onClick={() => openSettings('backends')}>
      {chat.openProviders}
    </button>
  )
}
