import { useState, type ReactNode } from 'react'
import type { AgentGroup, Bot } from '../../../shared/types'
import { createGroup, updateGroup } from '../state'
import { FormDialog } from './FormDialog'

export function GroupEditor({ group, bots, zh, onClose, onSaved }: { group: AgentGroup | null; bots: Bot[]; zh: boolean; onClose(): void; onSaved(group: AgentGroup): void }): ReactNode {
  const [name, setName] = useState(group?.name ?? '')
  const [members, setMembers] = useState(group?.botIds ?? [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return <FormDialog title={group ? (zh ? '编辑分组' : 'Edit group') : (zh ? '新建分组' : 'New group')} size="sm" onClose={() => { if (!busy) onClose() }}>
    <form onSubmit={event => {
      event.preventDefault()
      if (busy || !name.trim()) return
      setBusy(true); setError('')
      const patch: Partial<AgentGroup> = {}
      if (group && name.trim() !== group.name) patch.name = name.trim()
      if (group && JSON.stringify(members) !== JSON.stringify(group.botIds)) patch.botIds = members
      void (group ? updateGroup(group.id, patch) : createGroup(name.trim()))
        .then(saved => { if (saved) onSaved(saved); else setError(zh ? '分组未能保存，请重试。' : 'Could not save the group. Try again.') }).finally(() => setBusy(false))
    }}>
      <div className="ob-field"><label htmlFor="ob-group-edit-name">{zh ? '名称' : 'Name'}</label><input id="ob-group-edit-name" className="ob-input" value={name} onChange={event => setName(event.target.value)} required disabled={busy} /></div>
      {group ? <fieldset disabled={busy}><legend>{zh ? '成员' : 'Members'}</legend>{bots.filter(bot => !bot.archived).map(bot => <label key={bot.id} className="ob-check"><input type="checkbox" checked={members.includes(bot.id)} onChange={() => setMembers(value => value.includes(bot.id) ? value.filter(id => id !== bot.id) : [...value, bot.id])} />{bot.name}</label>)}</fieldset> : null}
      {error ? <p role="alert">{error}</p> : null}
      <button type="button" className="ob-btn ob-btn-sm" disabled={busy} onClick={onClose}>{zh ? '取消' : 'Cancel'}</button>
      <button type="submit" className="ob-btn ob-btn-sm ob-btn-primary" disabled={busy || !name.trim()}>{zh ? '保存' : 'Save'}</button>
    </form>
  </FormDialog>
}
