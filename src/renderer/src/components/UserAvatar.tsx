import { useState, type ReactNode } from 'react'
import type { Settings } from '../../../shared/settings'
import { profileImageSource } from '../../../shared/userProfile'
import './UserProfileSettings.css'

type Identity = Pick<Settings, 'profileName' | 'profileImage' | 'profileEmoji' | 'profileColor'>

export function UserAvatar({ profile, large = false }: { profile?: Identity | null; large?: boolean }): ReactNode {
  const src = profileImageSource(profile?.profileImage)
  const [failed, setFailed] = useState<string | null>(null)
  return <span className={`ob-profile-avatar ob-user-avatar${large ? ' is-large' : ''}`} style={{ background: profile?.profileColor || 'var(--ob-accent)' }} aria-hidden="true">
    {src && failed !== src ? <img src={src} alt="" draggable={false} onError={() => setFailed(src)} /> : (profile?.profileEmoji || '🙂')}
  </span>
}
