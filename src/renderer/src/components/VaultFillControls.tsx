import { useEffect, useState, type ReactNode } from 'react'
import type { VaultItem } from '../../../shared/vault'
import { useBotChinese } from './BotUiLanguage'

const LABELS: Record<string, [string, string]> = {
  username: ['用户名', 'Username'], password: ['密码', 'Password'], holder: ['持卡人', 'Cardholder'], number: ['卡号', 'Card number'], expiry: ['有效期', 'Expiry'], security_code: ['安全码', 'Security code'], recipient: ['收件人', 'Recipient'], street: ['街道', 'Street'], city: ['城市', 'City'], region: ['省 / 州', 'Region'], postal_code: ['邮编', 'Postal code'], country: ['国家 / 地区', 'Country']
}
/** This component receives metadata only; values are inserted by the main process. */
export function VaultFillControls({ botId, sessionId }: { botId: string; sessionId: string }): ReactNode {
  const zh = useBotChinese(), [items, setItems] = useState<VaultItem[]>([]), [selected, setSelected] = useState(''), [field, setField] = useState(''), [busy, setBusy] = useState(false), [status, setStatus] = useState('')
  useEffect(() => {
    let active = true
    void window.openbot.vault.list().then((result) => { if (active && result.ok) setItems(result.value.filter((item) => !!item.origin)) }).catch(() => { if (active) setStatus(zh ? '无法读取保险库。' : 'Could not read vault.') })
    return () => { active = false }
  }, [botId, zh])
  const item = items.find((value) => value.id === selected)
  async function fill(): Promise<void> {
    if (!item || !field || busy) return
    setBusy(true); setStatus('')
    try {
      const result = await window.openbot.vault.fill(botId, sessionId, item.id, field)
      setStatus(result.ok && result.value ? (zh ? '已填入当前字段。' : 'Filled the focused field.') : (zh ? '未填入。请确认 Bot 已停止、网站一致，且光标位于对应输入框。' : 'Not filled. Stop the Bot and focus the matching field on the saved website.'))
    } catch { setStatus(zh ? '未能填入，请检查浏览器和保险库。' : 'Could not fill the field.') } finally { setBusy(false) }
  }
  return <div className="ob-vault-fill">
    <label>{zh ? '保险库项目' : 'Vault item'} <select className="ob-select" value={selected} onChange={(event) => { setSelected(event.target.value); setField(''); setStatus('') }}><option value="">{zh ? '选择项目' : 'Select item'}</option>{items.map((value) => <option key={value.id} value={value.id}>{value.label} · {value.origin}</option>)}</select></label>
    <label>{zh ? '字段' : 'Field'} <select className="ob-select" value={field} disabled={!item} onChange={(event) => { setField(event.target.value); setStatus('') }}><option value="">{zh ? '选择字段' : 'Select field'}</option>{item?.fields.map((key) => <option value={key} key={key}>{LABELS[key]?.[zh ? 0 : 1] ?? key}</option>)}</select></label>
    <button type="button" className="ob-btn ob-btn-sm" disabled={!item || !field || busy} onClick={() => void fill()}>{busy ? (zh ? '正在填入…' : 'Filling…') : (zh ? '填入当前输入框' : 'Fill focused field')}</button>
    <p className="ob-hint">{zh ? '仅填入匹配网站和字段，不会提交。网站及之后控制页面的 Bot 可能读取已填内容。' : 'Fills only a matching website and field; it does not submit. The website and a Bot later controlling it may read the value.'}</p>
    {status ? <p className="ob-hint" role="status">{status}</p> : null}
  </div>
}
