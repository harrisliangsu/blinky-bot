import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { VaultItem, VaultKind } from '../../../shared/vault'
import { FormDialog } from './FormDialog'
import './SettingsVault.css'

const FIELDS: Record<VaultKind, Array<{ id: string; zh: string; en: string; secret?: boolean }>> = {
  login: [{ id: 'username', zh: '用户名', en: 'Username' }, { id: 'password', zh: '密码', en: 'Password', secret: true }],
  card: [{ id: 'holder', zh: '持卡人', en: 'Cardholder' }, { id: 'number', zh: '卡号', en: 'Card number', secret: true }, { id: 'expiry', zh: '有效期', en: 'Expiry', secret: true }, { id: 'security_code', zh: '安全码', en: 'Security code', secret: true }],
  address: [{ id: 'recipient', zh: '收件人', en: 'Recipient' }, { id: 'street', zh: '街道地址', en: 'Street' }, { id: 'city', zh: '城市', en: 'City' }, { id: 'region', zh: '省 / 州', en: 'Region' }, { id: 'postal_code', zh: '邮编', en: 'Postal code' }, { id: 'country', zh: '国家 / 地区', en: 'Country' }]
}

export function SettingsVault({ zh }: { zh: boolean }): ReactNode {
  const focusScope = useId()
  const remote = window.openbot.environment?.kind === 'browser'
  const host = (): void => { window.dispatchEvent(new CustomEvent('blinky:remote-host-required', { detail: zh ? '保险库的新增、修改、删除与敏感字段仅可在 Mac 上管理。远程可查看名称与引用，不传输凭据值。' : 'Manage vault items and sensitive fields on the Mac. Remote access shows labels and references only.' })) }
  const [items, setItems] = useState<VaultItem[]>([])
  const [kind, setKind] = useState<VaultKind>('login')
  const [label, setLabel] = useState('')
  const [origin, setOrigin] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)
  const closeDraft = (): void => {
    if (saving.current || busy) return
    setCreating(false); setValues({}); setEditing(null)
  }
  const [removing, setRemoving] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const load = async (): Promise<void> => {
    try {
      const result = await window.openbot.vault.list()
      if (result.ok) { setItems(result.value); setError('') }
      else setError(zh ? '无法读取保险库。请检查应用数据和系统加密状态。' : 'Could not read the vault.')
    } catch { setError(zh ? '无法读取保险库。' : 'Could not read the vault.') }
  }
  useEffect(() => { void load() }, [])

  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (saving.current || busy) return
    saving.current = true; setBusy(true); setError('')
    try {
      const result = editing ? await window.openbot.vault.update(editing, { label, origin, values }) : await window.openbot.vault.add({ kind, label, origin, values })
      if (!result.ok) { setError(zh ? '无法安全保存，请检查填写内容和系统加密状态。' : result.error); return }
      setLabel(''); setOrigin(''); setValues({}); setCreating(false); setEditing(null)
      await load()
    } catch { setError(zh ? '无法安全保存，请检查系统加密状态。' : 'Could not save securely.') } finally { saving.current = false; setBusy(false) }
  }
  const remove = async (id: string): Promise<void> => {
    setBusy(true); setError('')
    try {
      const result = await window.openbot.vault.remove(id)
      if (!result.ok || !result.value) { setError(zh ? '无法删除该项目。' : 'Could not remove this item.'); return }
      setRemoving(null); await load()
    } catch { setError(zh ? '无法删除该项目。' : 'Could not remove this item.') } finally { setBusy(false) }
  }

  return <div className="ob-vault" id={focusScope}>
    <div className="ob-vault-intro"><p>{zh ? '登录、银行卡和地址信息保存在本机，并由系统加密。敏感值不会显示在聊天中。' : 'Logins, cards and addresses are stored on this Mac with OS encryption. Secret values are not shown in chat.'}</p><button type="button" data-vault-add className="ob-btn ob-btn-sm" disabled={busy} onClick={() => { if (remote) { host(); return }; if (saving.current || busy) return; setEditing(null); setLabel(''); setOrigin(''); setCreating(true); setValues({}); setError('') }}>{remote ? (zh ? '在 Mac 管理' : 'Manage on Mac') : creating ? (zh ? '取消' : 'Cancel') : (zh ? '添加' : 'Add')}</button></div>
    {error && !creating ? <p className="ob-notice ob-notice-error" role="alert">{error}</p> : null}
    {creating && !remote ? <FormDialog fallbackFocus={`#${CSS.escape(focusScope)} [data-vault-add]`} title={editing ? (zh ? '修改保险库项目' : 'Edit vault item') : (zh ? '添加保险库项目' : 'Add vault item')} onClose={closeDraft} size="sm"><form className="ob-vault-form" aria-busy={busy} onSubmit={(event) => void save(event)} autoComplete="off">
      {error ? <p className="ob-notice ob-notice-error" role="alert">{error}</p> : null}
      <label>{zh ? '类型' : 'Type'}<select className="ob-select" disabled={busy || editing !== null} value={kind} onChange={(event) => { setKind(event.target.value as VaultKind); setValues({}) }}><option value="login">{zh ? '登录' : 'Login'}</option><option value="card">{zh ? '银行卡' : 'Card'}</option><option value="address">{zh ? '地址' : 'Address'}</option></select></label>
      <label>{zh ? '名称' : 'Name'}<input disabled={busy} className="ob-input" required maxLength={120} value={label} onChange={(event) => setLabel(event.target.value)} /></label>
      <label>{zh ? '网站（填入浏览器时必填）' : 'Website (required for browser fill)'}<input disabled={busy} className="ob-input" type="url" placeholder="https://example.com" value={origin} onChange={(event) => setOrigin(event.target.value)} /></label>
      {FIELDS[kind].map((field) => <label key={field.id}>{zh ? field.zh : field.en}<input disabled={busy} className="ob-input" type={field.secret ? 'password' : 'text'} autoComplete="off" spellCheck={false} placeholder={editing ? (zh ? '留空保留已保存的值' : 'Leave blank to keep saved value') : undefined} value={values[field.id] ?? ''} onChange={(event) => setValues((current) => ({ ...current, [field.id]: event.target.value }))} /></label>)}
      <button className="ob-btn ob-btn-primary" disabled={busy || !label.trim() || (!editing && !Object.values(values).some((value) => value.trim()))} type="submit">{busy ? (zh ? '保存中…' : 'Saving…') : (zh ? '安全保存' : 'Save securely')}</button>
    </form></FormDialog> : null}
    <div className="ob-vault-items">{items.length ? items.map((item) => <div className="ob-vault-item" key={item.id}>
      <div style={{ minWidth: 0 }}><strong>{item.label}</strong><small>{item.kind === 'login' ? (zh ? '登录' : 'Login') : item.kind === 'card' ? (zh ? '银行卡' : 'Card') : (zh ? '地址' : 'Address')}{item.origin ? ` · ${item.origin}` : ''}</small><small>{zh ? '引用：' : 'Reference: '}<code style={{ overflowWrap: 'anywhere', userSelect: 'text' }}>{`vault://ref/${item.id}`}</code></small></div>
      <button type="button" className="ob-btn ob-btn-sm" disabled={busy} onClick={() => { if (remote) { host(); return }; if (saving.current || busy) return; setKind(item.kind); setLabel(item.label); setOrigin(item.origin ?? ''); setValues({}); setError(''); setEditing(item.id); setCreating(true) }}>{zh ? '修改' : 'Edit'}</button>
      {removing === item.id ? <span className="ob-vault-actions"><button type="button" className="ob-btn ob-btn-sm" disabled={busy} onClick={() => void remove(item.id)}>{zh ? '确认删除' : 'Confirm'}</button><button type="button" className="ob-btn ob-btn-sm" onClick={() => setRemoving(null)}>{zh ? '取消' : 'Cancel'}</button></span> : <button type="button" className="ob-btn ob-btn-sm" onClick={() => { if (remote) host(); else setRemoving(item.id) }}>{zh ? '删除' : 'Remove'}</button>}
    </div>) : <p className="ob-hint">{zh ? '还没有保存项目。' : 'No items saved yet.'}</p>}</div>
    <p className="ob-hint">{zh ? '可将引用和字段名发给 Bot，请它在浏览器中经授权填入；不要发送真实值。也可接管后手动选择字段。网站和之后控制该页面的 Bot 可能读取已填内容。' : 'Share the reference and field name with a Bot for an authorized browser fill, without sharing the value. You can also take over and fill manually. The website and later browser actions may read filled values.'}</p>
  </div>
}
