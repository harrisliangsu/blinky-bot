import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TaskProgressMonitor, type ProgressDecision, type ProgressSnapshot } from './progressMonitor'

const snap = (id: string, phase: ProgressSnapshot['phase'], owner = 'o1'): ProgressSnapshot => ({
  id, owner, title: '任务 ' + id, phase, progress: 'proof-' + id, detail: '', terminal: ['completed', 'failed', 'cancelled'].includes(phase), needsAttention: false,
  evidence: [{ id: 'ev-' + id, kind: 'report', text: 'material change' }]
})

function harness(judgeFor: Map<string, ProgressDecision>) {
  const posted: string[] = []
  const monitor = new TaskProgressMonitor({
    snapshots: async () => [],
    read: async () => null,
    write: async () => {},
    judge: async (s) => s.progress.startsWith('initial-') ? { kind: 'silent' } : judgeFor.get(s.id) ?? { kind: 'silent' },
    post: async (_s, notice) => { posted.push(notice.text); return true },
    error: () => {}
  })
  return { monitor, posted }
}

test('a digest buys a quiet window: sibling routine milestones are swallowed, urgent states still post', async () => {
  TaskProgressMonitor.resetDigestState()
  const decisions: Map<string, ProgressDecision> = new Map([
    ['a', { kind: 'digest', lines: ['A 完成了', 'B 推进中', 'C 等待确认'] }],
    ['b', { kind: 'milestone', text: 'B 的常规进展', evidenceIds: ['ev-b'] }],
    ['c', { kind: 'milestone', text: 'C 需要你确认', evidenceIds: ['ev-c'] } as const]
  ])
  const { monitor, posted } = harness(decisions)
  const observe = (monitor as unknown as { observe(s: ProgressSnapshot): Promise<void> }).observe.bind(monitor)
  // Tasks already tracked are not "historical"; material changes re-judge.
  for (const id of ['a', 'b', 'c']) await observe({ ...snap(id, 'running'), progress: 'initial-' + id })
  await observe({ ...snap('a', 'completed'), progress: 'material-a' })
  await observe({ ...snap('b', 'running'), progress: 'material-b' })
  await observe({ ...snap('c', 'waiting_user'), progress: 'material-c', needsAttention: true })
  assert.equal(posted.length, 2)
  assert.ok(posted[0].includes('A 完成了'))
  assert.ok(!posted.some((text) => text.includes('B 的常规进展')))
  assert.ok(posted.some((text) => text.includes('C 需要你确认')))
})

test('digest cooldown degrades to the most urgent line instead of silencing the fact', async () => {
  TaskProgressMonitor.resetDigestState()
  const decisions: Map<string, ProgressDecision> = new Map([
    ['a', { kind: 'digest', lines: ['A 完成了'] }],
    ['d', { kind: 'digest', lines: ['D 也完成了', 'E 推进中'] }]
  ])
  const { monitor, posted } = harness(decisions)
  const observe = (monitor as unknown as { observe(s: ProgressSnapshot): Promise<void> }).observe.bind(monitor)
  await observe({ ...snap('a', 'running'), progress: 'initial-a' })
  await observe({ ...snap('d', 'running'), progress: 'initial-d' })
  await observe({ ...snap('a', 'completed'), progress: 'material-a' })
  await observe({ ...snap('d', 'completed'), progress: 'material-d' })
  assert.equal(posted.length, 2)
  assert.ok(posted[1].includes('D 也完成了'))
  assert.ok(!posted[1].includes('E 推进中'))
})
