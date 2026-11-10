import { useState } from 'react'
import type { Routine } from '../../../shared/types'
import { FormDialog } from './FormDialog'
import { RoutineTimingFields } from './RoutineTimingFields'

export function RoutineInstructionCreator({ botId, zh, onCreated }: { botId: string; zh: boolean; onCreated(routine: Routine): void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(''), [instruction, setInstruction] = useState('')
  const [trigger, setTrigger] = useState<Routine['trigger']>({ kind: 'schedule', cron: '0 9 * * 1-5' })
  const [policy, setPolicy] = useState<NonNullable<Routine['notifyPolicy']>>('always')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  return <>
    <button type="button" className="ob-btn ob-btn-sm" onClick={() => setOpen(true)}>{zh ? '新建任务指令' : 'New instruction'}</button>
    {open ? <FormDialog title={zh ? '新建任务指令' : 'New instruction'} size="md" onClose={() => { if (!busy) setOpen(false) }}>
    <form className="ob-routine-create" onSubmit={event => {
      event.preventDefault()
      if (busy || !botId) return
      setBusy(true); setError('')
      void window.openbot.routines.createInstruction(botId, name, instruction, trigger, policy).then(routine => {
        if (!routine) throw Error('create failed')
        onCreated(routine); setName(''); setInstruction(''); setOpen(false)
      }).catch(() => setError(zh ? '未能保存例程，请核对时间、时区、文件夹权限及当前 Bot 对话的执行模式。' : 'Could not save the routine. Check its schedule, timezone, folder access, and the Bot conversation’s execution mode.')).finally(() => setBusy(false))
    }}>
      <fieldset disabled={busy} aria-busy={busy}>
        <div className="ob-field"><label htmlFor="ob-routine-create-name">{zh ? '名称' : 'Name'}</label><input className="ob-input" id="ob-routine-create-name" value={name} onChange={event => setName(event.target.value)} maxLength={200} required /></div>
        <div className="ob-field"><label htmlFor="ob-routine-create-instruction">{zh ? '任务指令' : 'Instruction'}</label><textarea className="ob-textarea" id="ob-routine-create-instruction" rows={3} value={instruction} onChange={event => setInstruction(event.target.value)} required maxLength={20_000} /></div>
        <div className="ob-field"><label htmlFor="ob-routine-create-kind">{zh ? '触发方式' : 'Trigger'}</label><select className="ob-select" id="ob-routine-create-kind" value={trigger.kind} onChange={event => setTrigger(event.target.value === 'once' ? { kind: 'once', at: Math.ceil((Date.now() + 60_000) / 60_000) * 60_000 } : event.target.value === 'folder_change' ? { kind: 'folder_change', path: '' } : { kind: 'schedule', cron: '0 9 * * 1-5' })}>
          <option value="schedule">{zh ? '定时' : 'Schedule'}</option><option value="once">{zh ? '一次性' : 'Once'}</option><option value="folder_change">{zh ? '文件夹变化' : 'Folder changes'}</option>
        </select></div>
        <RoutineTimingFields id="ob-routine-create" trigger={trigger} onChange={setTrigger} zh={zh} />
        <div className="ob-field"><label htmlFor="ob-routine-create-notify">{zh ? '通知' : 'Notifications'}</label><select className="ob-select" id="ob-routine-create-notify" value={policy} onChange={event => setPolicy(event.target.value as NonNullable<Routine['notifyPolicy']>)}>
          <option value="always">{zh ? '每次记录通知' : 'Always'}</option><option value="on_change">{zh ? '有变化才通知' : 'On change'}</option><option value="quiet">{zh ? '安静，只保存结果' : 'Quiet'}</option>
        </select></div>
        <button type="button" className="ob-btn ob-btn-sm" onClick={() => setOpen(false)}>{zh ? '取消' : 'Cancel'}</button>
        <button className="ob-btn ob-btn-primary" type="submit" disabled={!botId || !name.trim() || !instruction.trim()}>{busy ? (zh ? '保存中…' : 'Saving…') : (zh ? '创建例程' : 'Create routine')}</button>
      </fieldset>
      {error ? <p className="ob-notice ob-notice-error" role="alert">{error}</p> : null}
    </form>
    </FormDialog> : null}
  </>
}
