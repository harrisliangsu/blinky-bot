import { useState, type ReactNode } from 'react'
import type { Bot } from '../../../shared/types'
import { resolveSettingsLang } from '../lib/settingsCopy'
import { startRecording, stopRecording, store, useAppState } from '../state'
import { IconRecord, IconStop } from './Icons'
import { FormDialog } from './FormDialog'
import './RoutineRecorder.css'

interface RoutineRecorderProps {
  bots: Bot[]
  botId: string
  onBotChange: (id: string) => void
}

/** Start/stop capture, with the live step counter while recording. */
export function RoutineRecorder({ bots, botId, onBotChange }: RoutineRecorderProps): ReactNode {
  const { recording, settings } = useAppState()
  const zh = resolveSettingsLang(settings?.language, typeof navigator === 'undefined' ? 'zh-CN' : navigator.language) === 'zh-CN'
  const [name, setName] = useState('')
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState(botId)
  const active = recording.state !== 'idle'

  if (active) {
    return (
      <div className="ob-recorder is-active">
        <span className="ob-recorder-live">
          <span className="ob-recorder-dot" aria-hidden="true" />
          {recording.state === 'paused' ? (zh ? '已暂停' : 'Paused') : (zh ? '正在录制' : 'Recording')}
        </span>
        <span className="ob-recorder-name">{recording.name}</span>
        <span className="ob-recorder-count" aria-live="polite">
          {zh ? `${recording.stepCount} 个步骤` : `${recording.stepCount} step${recording.stepCount === 1 ? '' : 's'}`}
        </span>
        <button type="button" className="ob-btn ob-btn-sm ob-btn-danger" onClick={() => void stopRecording()}>
          <IconStop size={11} />
          {zh ? '停止并保存' : 'Stop and save'}
        </button>
      </div>
    )
  }

  return (
    <div className="ob-recorder">
      <label className="ob-sr-only" htmlFor="ob-routine-bot">
        Bot
      </label>
      <select id="ob-routine-bot" className="ob-select ob-recorder-select" value={botId} onChange={(e) => onBotChange(e.target.value)}>
        {bots.map((b) => (
          <option key={b.id} value={b.id}>
            {b.emoji} {b.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="ob-btn ob-btn-sm"
        disabled={!botId}
        onClick={() => { setTarget(botId); setOpen(true) }}
        aria-label={zh ? '开始录制例程' : 'Start recording a routine'}
      >
        <IconRecord size={10} />
        {zh ? '录制' : 'Record'}
      </button>
      {open ? <FormDialog title={zh ? '录制例程' : 'Record routine'} size="sm" onClose={() => setOpen(false)}>
        <form onSubmit={event => { event.preventDefault(); if (target) void startRecording(target, name).then(() => { if (store.getState().recording.state !== 'idle') { onBotChange(target); setOpen(false) } }) }}>
      <label className="ob-sr-only" htmlFor="ob-routine-name">
        {zh ? '例程名称' : 'Routine name'}
      </label>
      <input
        id="ob-routine-name"
        className="ob-input ob-recorder-input"
        value={name}
        placeholder={zh ? '为要录制的例程命名' : 'Name the routine you are about to record'}
        onChange={(e) => setName(e.target.value)}
      />
          <label htmlFor="ob-record-target">Bot</label><select id="ob-record-target" className="ob-select" value={target} onChange={event => setTarget(event.target.value)}>{bots.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select>
          <button type="button" className="ob-btn ob-btn-sm" onClick={() => setOpen(false)}>{zh ? '取消' : 'Cancel'}</button>
          <button type="submit" className="ob-btn ob-btn-sm" disabled={!target}>{zh ? '开始录制' : 'Start recording'}</button>
        </form>
      </FormDialog> : null}
    </div>
  )
}
