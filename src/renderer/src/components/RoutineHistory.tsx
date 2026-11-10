import { useEffect, useState } from 'react'
import type { Routine, RoutineRun } from '../../../shared/routines'

export const routineStatus: Record<RoutineRun['status'], string> = { claimed: '准备中', running: '运行中', awaiting_review: '等待复核', finished: '本轮已结束', failed: '执行失败', missed: '已错过', unknown: '状态未知', skipped: '未执行' }
const notices: Record<NonNullable<RoutineRun['notificationState']>, string> = { ready: '待记录通知', pending: '通知处理中', recorded: '已记录通知', quiet: '安静记录', baseline: '已建立变化基线', unchanged: '内容未变化，未提醒', uncertain: '通知状态未知，未自动重发' }
const time = (at: number) => new Date(at).toLocaleString('zh-CN')

export function RoutineHistory({ routineId, webhook = false }: { routineId: string; webhook?: boolean }) {
  const [snapshot, setSnapshot] = useState<Routine | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true, loading = false
    setSnapshot(null); setError('')
    const refresh = async () => {
      if (loading) return
      loading = true
      try { const result = await window.openbot.routines.get(routineId); if (alive) { setSnapshot(result); setError(result ? result.runsError ?? '' : '此例程已不存在。') } }
      catch { if (alive) setError('无法读取运行记录，请检查本地存储。') }
      finally { loading = false }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 1200)
    return () => { alive = false; clearInterval(timer) }
  }, [routineId])
  return <section className="ob-routine-history" aria-label="例程运行记录">
    <h4 className="ob-label">运行记录</h4>
    {error ? <p className="ob-notice ob-notice-error" role="alert">{error}</p> : null}
    {!snapshot && !error ? <p className="ob-hint">正在读取…</p> : snapshot && !snapshot.runs?.length && !error ? <p className="ob-hint">{webhook ? '暂无运行记录；等待队列中的事件尚未执行。' : '暂无运行记录；未执行的计划不会显示为成功。'}</p> : null}
    <ol>{snapshot?.runs?.map(run => <li key={run.id} data-run-status={run.status}>
      <strong>{routineStatus[run.status]}</strong>
      <p className="ob-hint">{run.webhook ? '事件接收' : '计划'}：{time(run.scheduledAt)}{run.missedCount ? ` · 错过 ${run.missedCount} 次` : ''}</p>
      {run.startedAt ? <p className="ob-hint">开始：{time(run.startedAt)}</p> : <p className="ob-hint">{run.status === 'missed' || run.status === 'skipped' ? '未执行' : run.status === 'claimed' ? '尚未开始' : '开始时间未记录'}</p>}
      {run.endedAt ? <p className="ob-hint">记录结束：{time(run.endedAt)}</p> : null}
      {run.detail ? <p>{run.detail}</p> : null}
      {run.result ? <details><summary>查看结果</summary><p className="ob-routine-result">{run.result}</p></details> : null}
      {run.notificationState ? <p className="ob-hint">{notices[run.notificationState]}</p> : null}
    </li>)}</ol>
    {(snapshot?.runs?.length ?? 0) >= 100 ? <p className="ob-hint">显示最近 100 条记录。</p> : null}
  </section>
}
