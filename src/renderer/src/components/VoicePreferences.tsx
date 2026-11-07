import { useEffect, useState, type ReactNode } from 'react'
import type { Settings } from '../../../shared/settings'
import type { VoiceStatus } from '../../../shared/voice'
import { store } from '../state'
import { voiceError } from '../lib/voice'
export function VoicePreferences({ settings, zh }: { settings: Settings; zh: boolean }): ReactNode {
  const [status, setStatus] = useState<VoiceStatus | null>(null)
  const locale = settings.voiceLanguage ?? 'system'
  const [draft, setDraft] = useState(locale), [saving, setSaving] = useState(false), [error, setError] = useState('')
  useEffect(() => { setDraft(locale) }, [locale])
  const save = async (language: string): Promise<void> => {
    if (saving) return
    setDraft(language); setSaving(true); setError('')
    try {
      const reply = await window.openbot.voice.saveLanguage(language)
      if (!reply.ok) { setError(reply.error); return }
      const current = store.getState().settings
      if (current) store.patch({ settings: { ...current, voiceLanguage: reply.language } })
    } catch { setError(zh ? '语音语言未能保存，请重试。' : 'Voice language could not be saved. Try again.') }
    finally { setSaving(false) }
  }
  useEffect(() => { let live = true; setStatus(null); void window.openbot.voice.status(locale).then(s => { if (live) setStatus(s) }).catch(() => { if (live) setStatus({ speech: 'unavailable', microphone: 'unknown', onDevice: false, language: '' }) }); return () => { live = false } }, [locale])
  const warning = status && (status.microphone === 'denied' || status.microphone === 'restricted') ? 'microphone-permission'
    : status && (status.speech === 'denied' || status.speech === 'restricted') ? 'speech-permission'
      : status?.failure ? status.failure : status && (status.speech === 'unavailable' || (status.speech === 'authorized' && !status.onDevice)) ? 'unavailable' : null
  return <div className="ob-set-row">
    <div className="ob-set-row-text"><div className="ob-set-row-title">{zh ? '语音识别语言' : 'Speech recognition language'}</div>
      <p>{zh ? '在这台 Mac 上识别，不上传音频。点击输入框麦克风开始；使用所选语言的本地听写资源。' : 'Recognized on this Mac. No audio uploads. Click the composer microphone to start; requires on-device Dictation resources for your language.'}</p>
      {warning ? <p role="status">{voiceError(warning, zh)}</p> : null}
      {error ? <p role="alert">{error} <button type="button" className="ob-btn ob-btn-sm" onClick={() => void save(draft)} disabled={saving}>{zh ? '重试' : 'Retry'}</button></p> : null}
      {saving ? <p role="status">{zh ? '正在保存…' : 'Saving…'}</p> : null}
    </div>
    <div className="ob-set-row-control"><select className="ob-select ob-settings-select" aria-label={zh ? '语音语言' : 'Voice language'} value={draft} disabled={saving} onChange={e => void save(e.target.value)}>
      <option value="system">{zh ? '跟随系统' : 'System language'}</option><option value="zh-CN">中文（普通话）</option><option value="zh-TW">國語（台灣）</option><option value="en-US">English (US)</option><option value="en-GB">English (UK)</option><option value="ja-JP">日本語</option>
      {!['system', 'zh-CN', 'zh-TW', 'en-US', 'en-GB', 'ja-JP'].includes(locale) ? <option value={locale}>{locale}</option> : null}
    </select></div>
  </div>
}
