import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { Settings, UserProfilePatch } from '../../../shared/settings'
import { saveUserProfile } from '../state/preferences'
import { useBotChinese } from './BotUiLanguage'
import { UserAvatar } from './UserAvatar'
import { readProfileImage } from './profileImage'
import './UserProfileSettings.css'

/** The human user's local identity, with a draft separate from saved settings. */
export function UserProfileSettings({ settings }: { settings: Settings }): ReactNode {
  const zh = useBotChinese(), id = useId()
  const [name, setName] = useState<string | null>(null)
  const [image, setImage] = useState<string | null>(null)
  const [reading, setReading] = useState(false), [saving, setSaving] = useState(false)
  const [error, setError] = useState(''), [status, setStatus] = useState('')
  const fileInput = useRef<HTMLInputElement>(null), readVersion = useRef(0)
  useEffect(() => () => { readVersion.current++ }, [])
  const draft = { ...settings, profileName: name ?? settings.profileName, profileImage: image ?? settings.profileImage }
  const changed = draft.profileName.trim() !== settings.profileName || (draft.profileImage || '') !== (settings.profileImage || '')
  const cancel = (): void => {
    readVersion.current++; setReading(false); setName(null); setImage(null); setError(''); setStatus(zh ? '已取消修改' : 'Changes cancelled')
    if (fileInput.current) fileInput.current.value = ''
  }
  const choose = async (file?: File): Promise<void> => {
    if (!file) return
    const version = ++readVersion.current
    setReading(true); setError(''); setStatus('')
    try {
      const source = await readProfileImage(file)
      if (version === readVersion.current) setImage(source)
    } catch {
      if (version === readVersion.current) setError(zh ? '无法读取这张图片，请选择 5 MB 以内的 PNG、JPEG、WebP 或 GIF 图片。' : 'Could not read this image. Choose a PNG, JPEG, WebP or GIF under 5 MB.')
    } finally { if (version === readVersion.current) setReading(false) }
  }
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (reading || saving || !changed) return
    const patch: UserProfilePatch = {}
    if (name !== null) patch.profileName = name.trim()
    if (image !== null) patch.profileImage = image
    setSaving(true); setError(''); setStatus('')
    const result = await saveUserProfile(patch)
    setSaving(false)
    if (!result.ok) { setError(zh ? '个人资料未能保存，请重试。' : 'Your profile could not be saved. Try again.'); return }
    setName(null); setImage(null); setStatus(zh ? '个人资料已保存' : 'Profile saved')
  }
  return <section className="ob-set-card ob-user-profile" aria-label={zh ? '编辑个人资料' : 'Edit profile'}>
    <h3>{zh ? '个人资料' : 'Profile'}</h3>
    <form onSubmit={(event) => void save(event)}>
      <div className="ob-user-profile-photo">
        <UserAvatar profile={draft} large />
        <div><button type="button" className="ob-btn ob-btn-sm" disabled={saving || reading} onClick={() => fileInput.current?.click()}>{reading ? (zh ? '读取中…' : 'Reading…') : (zh ? '更改头像' : 'Change photo')}</button>
          {draft.profileImage ? <button type="button" className="ob-btn ob-btn-sm ob-btn-ghost" disabled={saving || reading} onClick={() => { setImage(''); setError(''); setStatus('') }}>{zh ? '移除照片' : 'Remove photo'}</button> : null}
        </div>
        <input ref={fileInput} data-profile-file type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="ob-sr-only" tabIndex={-1} aria-label={zh ? '选择头像图片' : 'Choose profile photo'} disabled={saving || reading} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; void choose(file) }} />
      </div>
      <div className="ob-field"><label htmlFor={id}>{zh ? '用户名' : 'Display name'}</label>
        <input id={id} data-profile-name className="ob-input" value={draft.profileName} maxLength={80} disabled={saving} onChange={(event) => { setName(event.target.value); setStatus('') }} aria-describedby={`${id}-hint`} />
        <small id={`${id}-hint`} className="ob-hint">{zh ? '用于侧边栏和个人资料。' : 'Shown in the sidebar and your profile.'}</small>
      </div>
      <div className="ob-profile-preview" aria-label={zh ? '个人资料预览' : 'Profile preview'}><UserAvatar profile={draft} /><span>{draft.profileName.trim() || (zh ? '个人资料' : 'Profile')}</span></div>
      {error ? <p role="alert" className="ob-user-profile-error">{error}</p> : null}
      <p role="status" className="ob-user-profile-status">{status}</p>
      <footer className="ob-user-profile-actions"><button type="button" className="ob-btn ob-btn-sm" disabled={saving} onClick={cancel}>{zh ? '取消' : 'Cancel'}</button><button type="submit" className="ob-btn ob-btn-sm ob-btn-primary" disabled={!changed || reading || saving}>{saving ? (zh ? '保存中…' : 'Saving…') : (zh ? '保存' : 'Save')}</button></footer>
    </form>
  </section>
}
