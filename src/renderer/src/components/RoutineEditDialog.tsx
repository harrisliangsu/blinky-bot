import { useState, type ReactNode } from 'react'
import type { Routine } from '../../../shared/types'
import { loadRoutines } from '../state'
import { FormDialog } from './FormDialog'
import { RoutineTimingFields } from './RoutineTimingFields'

/** Keep edits local; polling updates must not replace unfinished text. */
export function RoutineEditDialog({ routine, zh, onClose }: { routine: Routine; zh: boolean; onClose(): void }): ReactNode {
  const [instruction, setInstruction] = useState(routine.instruction ?? '')
  const [original] = useState(routine)
  const [trigger, setTrigger] = useState(routine.trigger)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return <FormDialog title={zh ? '编辑例程' : 'Edit routine'} size="md" onClose={() => { if (!busy) onClose() }}>
    <form onSubmit={event => {
      event.preventDefault()
      if (busy || (routine.instruction && !instruction.trim())) return
      setBusy(true); setError('')
      const patch: Partial<Routine> = {}
      if (original.instruction && instruction.trim() !== original.instruction) patch.instruction = instruction.trim()
      if (JSON.stringify(trigger) !== JSON.stringify(original.trigger)) patch.trigger = trigger
      void window.openbot.routines.update(routine.id, patch).then(async saved => {
        if (!saved) throw Error('save failed')
        await loadRoutines(); onClose()
      }).catch(() => setError(zh ? '未能保存，修改内容已保留。' : 'Could not save. Your edits are still here.')).finally(() => setBusy(false))
    }}>
      <fieldset disabled={busy} style={{ border: 0, padding: 0, minWidth: 0 }}>
        {routine.instruction ? <div className="ob-field"><label htmlFor="ob-routine-edit-instruction">{zh ? '任务指令' : 'Instruction'}</label><textarea id="ob-routine-edit-instruction" className="ob-textarea" rows={5} value={instruction} onChange={event => setInstruction(event.target.value)} required /></div> : null}
        <RoutineTimingFields id="ob-routine-edit" trigger={trigger} onChange={setTrigger} zh={zh} />
        {error ? <p role="alert">{error}</p> : null}
        <button type="button" className="ob-btn ob-btn-sm" onClick={onClose}>{zh ? '取消' : 'Cancel'}</button>
        <button type="submit" className="ob-btn ob-btn-sm ob-btn-primary">{zh ? '保存' : 'Save'}</button>
      </fieldset>
    </form>
  </FormDialog>
}
