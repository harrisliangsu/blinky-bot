import type { Routine } from '../../../shared/types'

type Trigger = Routine['trigger']
function localInput(at?: number): string {
  if (at === undefined || !Number.isFinite(at)) return ''
  const date = new Date(at)
  return new Date(at - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}
export function RoutineTimingFields({ id, trigger, onChange, zh }: { id: string; trigger: Trigger; onChange(value: Trigger): void; zh: boolean }) {
  const remote = window.openbot.environment?.kind === 'browser'
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  if (trigger.kind === 'folder_change') return <div className="ob-field">
    <label htmlFor={`${id}-folder`}>{zh ? '观察文件夹' : 'Folder to watch'}</label>
    <div className="ob-row">
      <input className="ob-input" id={`${id}-folder`} value={trigger.path ?? ''} onChange={event => onChange({ ...trigger, path: event.target.value })} spellCheck={false} />
      <button type="button" className="ob-btn ob-btn-sm" onClick={() => void window.openbot.dialog.pickDirectory().then(path => { if (path) onChange({ ...trigger, path }) })}>{zh ? '选择' : 'Choose'}</button>
    </div>
    <p className="ob-hint">{zh ? '递归比较名称和文件系统元数据，不读文件内容、不跟随子项符号链接。首次静默建立基线，轮询可能遗漏两次检查之间的变化；失读或扫描超限会明确显示。' : 'Recursively compares names and metadata without reading file contents or following child symlinks. The first snapshot is silent; changes between polls may be missed. Unreadable or oversized scans report errors.'}</p>
  </div>
  if (trigger.kind !== 'schedule' && trigger.kind !== 'once') return null
  return <>
    {trigger.kind === 'schedule' ? <div className="ob-field">
      <label htmlFor={`${id}-cron`}>{zh ? 'Cron 表达式' : 'Cron expression'}</label>
      <input className="ob-input" id={`${id}-cron`} value={trigger.cron ?? ''} onChange={event => onChange({ ...trigger, cron: event.target.value })} placeholder="0 9 * * 1-5" spellCheck={false} />
      <label htmlFor={`${id}-tz`}>{zh ? (remote ? '时区（留空使用 Mac 主机）' : '时区（留空使用本机）') : 'Timezone (blank uses this Mac)'}</label>
      <input className="ob-input" id={`${id}-tz`} value={trigger.tz ?? ''} onChange={event => onChange({ ...trigger, tz: event.target.value || undefined })} placeholder="Asia/Shanghai" spellCheck={false} />
    </div> : <div className="ob-field">
      <label htmlFor={`${id}-at`}>{remote ? (zh ? `一次性时间（此设备：${zone}）` : `Once, this device’s timezone (${zone})`) : (zh ? '一次性时间（本机时区）' : 'Once, in this Mac’s timezone')}</label>
      <input className="ob-input" id={`${id}-at`} type="datetime-local" value={localInput(trigger.at)} onChange={event => onChange({ ...trigger, at: event.target.value ? new Date(event.target.value).getTime() : undefined })} />
      <p className="ob-hint">{zh ? '按所选时间所在分钟触发一次。超过允许窗口会记为已错过，不自动补跑；实际开始时间单独记录。' : 'Runs once within the selected minute. A missed window is recorded without automatic replay; actual start time is recorded separately.'}</p>
    </div>}
    <details className="ob-routine-timing-options"><summary>{zh ? '允许的时间偏移' : 'Allowed timing window'}</summary>
      {trigger.kind === 'schedule' ? <label>{zh ? '可提前（分钟）' : 'Early minutes'}<input className="ob-input" type="number" min={0} max={527040} value={trigger.earlyMinutes ?? 0} onChange={event => onChange({ ...trigger, earlyMinutes: Number(event.target.value) })} /></label> : null}
      <label>{zh ? '可延后（分钟）' : 'Late minutes'}<input className="ob-input" type="number" min={0} max={527040} value={trigger.lateMinutes ?? 0} onChange={event => onChange({ ...trigger, lateMinutes: Number(event.target.value) })} /></label>
      <p className="ob-hint">{zh ? '默认均为 0，保持当前分钟的运行窗口。关闭窗口后运行还需要后台设置和 macOS 注册成功；休眠、关机及未登录时不能保证执行。' : 'Both default to 0, preserving the current-minute window. Running with the window closed requires background execution and macOS registration; execution is not guaranteed while asleep, powered off, or logged out.'}</p>
    </details>
  </>
}
