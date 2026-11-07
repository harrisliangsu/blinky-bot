import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Routine } from '../../../shared/types'
import { relativeTime } from '../lib/format'
import { resolveSettingsLang } from '../lib/settingsCopy'
import { loadRoutines, removeRoutine, runRoutine, store, updateRoutine, useAppState } from '../state'
import { IconPlay, IconTrash } from './Icons'
import { Modal } from './Modal'
import { RoutineRecorder } from './RoutineRecorder'
import { RoutineSteps } from './RoutineSteps'
import './RoutinePanel.css'
import { RoutineHistory, routineStatus } from './RoutineHistory'
import { RoutineInstructionCreator } from './RoutineInstructionCreator'
import { RoutineEditDialog } from './RoutineEditDialog'

const MODES: Array<{ id: Routine['replayMode']; label: string; hint: string }> = [
  { id: 'literal', label: 'Literal', hint: 'Replays the captured coordinates exactly.' },
  { id: 'adaptive', label: 'Adaptive', hint: 'Re-plans each step with the model against what is on screen.' }
]

/** Record and replay routines, grouped by the bot that owns them. */
export function RoutinePanel(): ReactNode {
  const { bots, routines, routinesError, recording, currentSessionId, settings } = useAppState()
  const zh = resolveSettingsLang(settings?.language, typeof navigator === 'undefined' ? 'zh-CN' : navigator.language) === 'zh-CN'
  const [botId, setBotId] = useState(() => bots[0]?.id ?? '')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [cronDraft, setCronDraft] = useState('0 9 * * 1-5')
  const [editing, setEditing] = useState(false)
  const [webhook, setWebhook] = useState<{ url: string; secret: string; state: 'inactive' | 'listening' | 'error' } | null>(null)
  const [webhookError, setWebhookError] = useState(false)
  const [manualRunning, setManualRunning] = useState(false)
  const [runError, setRunError] = useState('')

  useEffect(() => {
    void loadRoutines()
  }, [])

  useEffect(() => {
    if (!botId && bots.length > 0) setBotId(bots[0]!.id)
  }, [bots, botId])

  const forBot = useMemo(() => routines.filter((r) => r.botId === botId), [routines, botId])
  const selected = forBot.find((r) => r.id === selectedId) ?? forBot[0] ?? null
  const selectedRef = useRef<string | undefined>(undefined)
  selectedRef.current = selected?.id
  const activeMode = selected?.replayMode ?? 'literal'

  useEffect(() => {
    setCronDraft(selected?.trigger.cron ?? '0 9 * * 1-5')
  }, [selected?.id, selected?.trigger.cron])
  useEffect(() => { setWebhook(null); setWebhookError(false) }, [selected?.id])

  return (
    <Modal title={zh ? '例程' : 'Routines'} subtitle={zh ? '查看定时指令或录制的任务。' : 'View scheduled instructions and recorded tasks.'} size="lg" onClose={() => store.setModal(null)}>
      <div className="ob-routines">
        <RoutineRecorder bots={bots} botId={botId} onBotChange={setBotId} />
        {bots.length ? <RoutineInstructionCreator botId={botId} zh={zh} onCreated={routine => { void loadRoutines(); setSelectedId(routine.id) }} /> : null}

        {recording.state !== 'idle' ? (
          <section className="ob-routine-live">
            <h3 className="ob-label">{zh ? '已录制的步骤' : 'Captured so far'}</h3>
            <RoutineSteps steps={recording.steps} emptyText={zh ? '尚未录制步骤。与屏幕交互后会显示在这里。' : 'No steps captured yet. Interact with the screen and they appear here.'} />
          </section>
        ) : null}

        {routinesError ? (
          <p className="ob-notice ob-notice-error" role="alert">
            {routinesError}
          </p>
        ) : null}

        {bots.length === 0 ? (
          <p className="ob-hint">{zh ? '请先创建 Bot，例程需要归属于一个 Bot。' : 'Create a bot first — routines belong to a bot.'}</p>
        ) : (
          <div className="ob-routines-body">
            <div className="ob-routines-list">
              <h3 className="ob-label">{zh ? '例程列表' : 'Routines'}</h3>
              {forBot.length === 0 ? (
                <p className="ob-hint">{zh ? '这个 Bot 暂无例程。' : 'This bot has no routines yet.'}</p>
              ) : (
                <ul>
                  {forBot.map((routine) => (
                    <li key={routine.id}>
                      <button
                        type="button"
                        className={`ob-routine-row${selected?.id === routine.id ? ' is-active' : ''}`}
                        onClick={() => setSelectedId(routine.id)}
                      >
                        <span className="ob-routine-name">{routine.name}</span>
                        <span className="ob-routine-meta">
                          {routine.instruction ? (zh ? '任务指令' : 'Instruction') : zh ? `${routine.steps.length} 个步骤` : `${routine.steps.length} steps`}
                          {routine.lastRunAt ? (zh ? ` · 上次计划 ${new Date(routine.lastRunAt).toLocaleString('zh-CN')}` : ` · last occurrence ${relativeTime(routine.lastRunAt)}`) : ''}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="ob-routine-detail">
              {!selected ? (
                <p className="ob-hint">{zh ? '选择一个例程查看步骤。' : 'Select a routine to see its steps.'}</p>
              ) : (
                <>
                  <header className="ob-routine-detail-head">
                    <div>
                      <h3>{selected.name}</h3>
                      <p className="ob-hint">{selected.description || (zh ? '暂无描述。' : 'No description.')}</p>
                    </div>
                    <div className="ob-routine-actions">
                      <button
                        type="button"
                        className="ob-btn ob-btn-sm ob-btn-primary"
                        onClick={() => {
                          if (!currentSessionId || manualRunning) return
                          setManualRunning(true); setRunError('')
                          void window.openbot.routines.run(selected.id, currentSessionId).then((result: unknown) => { if (result !== true) setRunError('本次运行未确认，请检查 Bot 对话及运行记录。') }).catch(() => setRunError('运行请求失败，请检查本地存储。')).finally(() => setManualRunning(false))
                        }}
                        disabled={!currentSessionId || manualRunning}
                        title={currentSessionId ? undefined : (zh ? '请先打开对话' : 'Open a conversation first')}
                      >
                        <IconPlay size={11} />
                        {zh ? '运行' : 'Run'}
                      </button>
                      <button
                        type="button"
                        className="ob-icon-btn"
                        aria-label={zh ? `删除 ${selected.name}` : `Delete ${selected.name}`}
                        onClick={() => void removeRoutine(selected.id)}
                      >
                        <IconTrash size={12} />
                      </button>
                      <button type="button" className={`ob-mode-btn${selected.trigger.kind === 'once' ? ' is-active' : ''}`} aria-pressed={selected.trigger.kind === 'once'} onClick={() => void updateRoutine(selected.id, { trigger: { kind: 'once', at: Math.ceil((Date.now() + 60_000) / 60_000) * 60_000 } })}>{zh ? '一次性' : 'Once'}</button>
                      {selected.instruction ? <button type="button" className={`ob-mode-btn${selected.trigger.kind === 'folder_change' ? ' is-active' : ''}`} aria-pressed={selected.trigger.kind === 'folder_change'} onClick={() => void window.openbot.dialog.pickDirectory().then(path => { if (path) void updateRoutine(selected.id, { trigger: { kind: 'folder_change', path } }) })}>{zh ? '文件夹变化' : 'Folder changes'}</button> : null}
                    </div>
                  </header>

                  {runError ? <p className="ob-notice ob-notice-error" role="alert">{runError}</p> : null}
                  {selected.lastRunState ? <p className="ob-hint" role={selected.lastRunState === 'failed' || selected.lastRunState === 'unknown' ? 'alert' : undefined}>
                    {routineStatus[selected.lastRunState]}
                    {selected.lastRunError ? ` · ${selected.lastRunError}` : ''}
                  </p> : null}
                  <div className="ob-field"><label className="ob-label" htmlFor={`routine-notify-${selected.id}`}>通知</label>
                    <select id={`routine-notify-${selected.id}`} className="ob-select" value={selected.notifyPolicy ?? 'always'} onChange={event => void updateRoutine(selected.id, { notifyPolicy: event.target.value as Routine['notifyPolicy'] })}>
                      <option value="always">每次记录通知</option><option value="on_change">有变化才通知</option><option value="quiet">安静，只保存结果</option>
                    </select>
                    <p className="ob-hint">变化按本轮结果内容比较，首次成功只建立基线；安静模式仍可在运行记录查看结果。桌面提醒受系统及全局通知设置影响。</p>
                  </div>
                  <RoutineHistory routineId={selected.id} webhook={selected.trigger.kind === 'webhook'} />

                  {!selected.instruction ? <div className="ob-field">
                    <span className="ob-label">{zh ? '回放方式' : 'Replay mode'}</span>
                    <span className="ob-routine-mode">{zh ? (activeMode === 'literal' ? '原样回放' : '自适应回放') : MODES.find((m) => m.id === activeMode)?.label}</span>
                    <p className="ob-hint">{zh ? (activeMode === 'literal' ? '按录制的坐标操作。' : '根据屏幕内容重新规划每个步骤。') + '回放方式在录制时确定。' : `${MODES.find((m) => m.id === activeMode)?.hint} Set when the routine was recorded.`}</p>
                  </div> : null}

                  <div className="ob-field">
                    <span className="ob-label">{zh ? '运行时间' : 'Schedule'}</span>
                    <div className="ob-mode" role="group" aria-label={zh ? '例程运行时间' : 'Routine schedule'}>
                      <button
                        type="button"
                        className={`ob-mode-btn${selected.trigger.kind === 'manual' ? ' is-active' : ''}`}
                        aria-pressed={selected.trigger.kind === 'manual'}
                        onClick={() => void updateRoutine(selected.id, { trigger: { kind: 'manual' } })}
                      >
                        {zh ? '手动' : 'Manual'}
                      </button>
                      <button
                        type="button"
                        className={`ob-mode-btn${selected.trigger.kind === 'schedule' ? ' is-active' : ''}`}
                        aria-pressed={selected.trigger.kind === 'schedule'}
                        onClick={() => void updateRoutine(selected.id, { trigger: { kind: 'schedule', cron: cronDraft } })}
                      >
                        {zh ? '定时' : 'Scheduled'}
                      </button>
                    </div>
                    {selected.trigger.kind === 'github_issue' ? <p className="ob-hint">{zh ? '监听 GitHub 变化' : 'Watching GitHub'}：{selected.trigger.owner}/{selected.trigger.repo} #{selected.trigger.issueNumber}{selected.watchError ? ` · ${selected.watchError}` : ''}</p> : null}
                    {selected.trigger.kind === 'gmail_query' ? <p className="ob-hint">{zh ? '监听 Gmail 查询变化' : 'Watching Gmail query'}：{selected.trigger.query || (zh ? '全部邮件' : 'All mail')}{selected.watchError ? ` · ${selected.watchError}` : ''}</p> : null}
                    {selected.trigger.kind === 'webhook' ? <div className="ob-field">
                      <p className="ob-hint">{zh ? 'Webhook 只监听本机，远程发送需自行配置安全的转发；请求正文不会传给 Bot。' : 'Webhook listens locally only; remote delivery requires your own secure tunnel. Request bodies are not sent to the Bot.'}</p>
                      <p className="ob-hint">{zh ? '为防止重复执行，事件标识会保存在本机，长期使用会占用少量存储空间。' : 'Event identifiers are stored locally to prevent duplicates and use a small amount of space over time.'}</p>
                      <button type="button" className="ob-btn ob-btn-sm" onClick={() => { const id = selected.id; void window.openbot.routines.webhookSetup(id).then((value) => { if (selectedRef.current === id) { setWebhook(value); setWebhookError(!value) } }).catch(() => { if (selectedRef.current === id) setWebhookError(true) }) }}>{zh ? '显示连接信息' : 'Show connection details'}</button>
                      {webhookError ? <p className="ob-notice ob-notice-error" role="alert">{zh ? '无法读取加密凭证。' : 'Could not access the encrypted credential.'}</p> : null}
                      {webhook ? <>
                        <p className="ob-hint">{webhook.url}</p>
                        <p className="ob-hint">{zh ? 'POST 请求须携带 Authorization: Bearer 凭证，以及每次事件唯一的 X-Blinky-Event-Id。重复事件不会再次入队。' : 'POST with Authorization: Bearer and a unique X-Blinky-Event-Id for each event. Duplicate events are not enqueued again.'}</p>
                        <button type="button" className="ob-btn ob-btn-sm" onClick={() => void navigator.clipboard.writeText(webhook.secret)}>{zh ? '复制凭证' : 'Copy credential'}</button>
                        <p className="ob-hint">{webhook.state === 'error' ? (zh ? '监听端口不可用，请检查端口占用。' : 'The listener is unavailable; check whether its port is in use.') : webhook.state === 'inactive' ? (zh ? '监听正在启动，可再次点击检查。' : 'The listener is starting; check again shortly.') : (zh ? '本机监听中。' : 'Listening locally.')}</p>
                      </> : null}
                    </div> : null}
                    {['schedule', 'once', 'folder_change'].includes(selected.trigger.kind) ? <button type="button" className="ob-btn ob-btn-sm" onClick={() => setEditing(true)}>{zh ? '编辑触发设置' : 'Edit trigger'}</button> : null}
                    {selected.trigger.kind === 'folder_change' && selected.watchError ? <p className="ob-notice ob-notice-error" role="alert">{selected.watchError}</p> : null}
                  </div>

                  {selected.instruction ? <div className="ob-field">
                    <span className="ob-label">{zh ? '任务指令' : 'Instruction'}</span>
                    <p style={{ whiteSpace: 'pre-wrap' }}>{selected.instruction}</p>
                    <button type="button" className="ob-btn ob-btn-sm" onClick={() => setEditing(true)}>{zh ? '编辑任务指令' : 'Edit instruction'}</button>
                    <p className="ob-hint">{zh ? '后台设置开启且注册成功后，关闭窗口仍可触发。电脑休眠、关机、未登录或错过允许时间窗口时不会声称已执行。' : 'With background execution enabled and registered, routines can run after the window closes. Sleep, shutdown, logout, or a missed window is never reported as execution.'}</p>
                  </div> : <div className="ob-field">
                    <span className="ob-label">{zh ? '步骤' : 'Steps'}</span>
                    <RoutineSteps steps={selected.steps} emptyText={zh ? '此例程没有步骤。' : 'This routine has no steps.'} />
                  </div>}

                  {!currentSessionId ? <p className="ob-hint">{zh ? '请先打开对话，再运行例程。' : 'Open a conversation to run this routine.'}</p> : null}
                </>
              )}
            </div>
          </div>
        )}
        {editing && selected ? <RoutineEditDialog key={selected.id} routine={selected} zh={zh} onClose={() => setEditing(false)} /> : null}
      </div>
    </Modal>
  )
}
