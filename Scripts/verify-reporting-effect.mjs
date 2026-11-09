// Effect review for the two reporting paths (milestone vs digest) with the
// real model. Sets up an isolated environment, two owned tasks with real
// report receipts, drives judgeTaskProgress through the governed Bot turn,
// and prints the decisions for audit.
//
//   node --experimental-transform-types --import ./scripts/register-ts.mjs Scripts/verify-reporting-effect.mjs
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blinky-report-fx-'))
process.env.OPENBOT_DATA_DIR = path.join(root, 'app-data')
await fs.mkdir(process.env.OPENBOT_DATA_DIR, { recursive: true })
const realCodex = path.join(process.env.HOME, '.local/bin/codex')
await fs.writeFile(path.join(process.env.OPENBOT_DATA_DIR, 'settings.json'), JSON.stringify({
  theme: 'light', language: 'zh-CN', defaultBackendId: 'codex', defaultModelId: 'default', memoryExtraction: 'off',
  backends: { codex: { enabled: true, command: realCodex, extraArgs: [] } }
}))
await fs.mkdir(path.join(process.env.OPENBOT_DATA_DIR, 'bots'))
await fs.writeFile(path.join(process.env.OPENBOT_DATA_DIR, 'bots', 'bot.json'), JSON.stringify({
  id: 'bot', name: 'Developer', description: '', systemPrompt: 'You manage background tasks.', emoji: '✨', color: '#7c9cff',
  backendId: 'codex', modelId: 'default', followsDefault: false, tools: ['manage_task'], computerUse: false, computerTarget: { kind: 'local' }, createdAt: 1, updatedAt: 1
}))

const { loadBots } = await import('../src/main/store/bots.ts')
const { loadSessions } = await import('../src/main/store/sessions.ts')
const { createSession, saveSession } = await import('../src/main/store/sessions.ts')
const { createTaskRecord, recordTaskProgress, setTaskStatus } = await import('../src/main/store/tasks.ts')
const { saveTaskMessages } = await import('../src/main/tasks/messages.ts')
const { progressSnapshot } = await import('../src/main/tasks/progressObservations.ts')
const { judgeTaskProgress } = await import('../src/main/tasks/progressDecision.ts')
const { parseTaskPlan } = await import('../src/main/tasks/planning.ts')
const { flushAll } = await import('../src/main/store/jsonStore.ts')

await loadBots()
await loadSessions()
const session = createSession(['bot'], root)
saveSession({ ...session, mode: 'agent' })

const mkTask = (id, title, summary, scope) => createTaskRecord('bot', 'exec-' + id, summary, title, {
  sourceSessionId: session.id,
  executionAgent: { backendId: 'codex', modelId: 'default' },
  plan: parseTaskPlan({ context: { summary, categories: ['功能开发'], scope, boundaries: ['不发布'] } }, root, session.id, 'bot', [])
})

const taskA = mkTask('a', '报表导出优化', '优化报表导出性能并补齐 PDF 支持', ['src/export'])
setTaskStatus(taskA.id, 'running')
await recordTaskProgress(taskA.id, { phase: 'running', detail: '正在处理“导出管道改造”。', milestones: [], updatedAt: Date.now() })
await saveTaskMessages(taskA.id, [{ id: 'rep-a1', taskId: taskA.id, direction: 'to_lead', status: 'delivered', text: '导出管道改造完成并通过应用回读校验：src/export/report.pdf 存在且内容符合验收要求，用户要求的 PDF 支持已可用。', createdAt: Date.now(), updatedAt: Date.now() }])

async function judgeTask(taskId, label) {
  const fresh = (await import('../src/main/store/tasks.ts')).getTask(taskId)
  const receipts = [{ id: 'rep-a1', taskId: taskA.id, direction: 'to_lead', status: 'delivered', text: '导出管道改造完成并通过应用回读校验：src/export/report.pdf 存在且内容符合验收要求，用户要求的 PDF 支持已可用。', createdAt: Date.now(), updatedAt: Date.now() }]
  const snapshot = progressSnapshot(fresh, receipts)
  if (taskId === taskA.id && !snapshot.evidence.some((e) => e.id.startsWith('execution:'))) {
    snapshot.evidence = [...(snapshot.evidence ?? []), { id: 'execution:m1:c1', kind: 'tool', text: JSON.stringify({ call: 'verify_file', ok: true, output: 'src/export/report.pdf 回读与用户要求逐项一致' }) }]
  }
  void taskA
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 240000)
  const started = Date.now()
  try {
    const decision = await judgeTaskProgress(snapshot, controller.signal)
    console.log(`=== ${label} (${Date.now() - started}ms) ===`)
    console.log(JSON.stringify(decision, null, 2))
    return decision
  } finally { clearTimeout(timer) }
}

// Scenario 1: single active task — expect a plain milestone, no digest data.
await judgeTask(taskA.id, '场景1：A 单任务里程碑级证据')

// Scenario 2: B waiting on a user decision — its own judgment must surface the action.
const taskB = mkTask('b', '登录双因素认证', '给登录流程加双因素认证', ['src/auth'])
setTaskStatus(taskB.id, 'running')
await recordTaskProgress(taskB.id, { phase: 'waiting_user', detail: '等待你确认验证方式。', blocker: '等待你确认验证方式。', milestones: [{ text: '流程梳理完成', at: Date.now() }], updatedAt: Date.now() })
// Real waiting_user phase comes from the clarification event, not the record.
const { observeProgressEvent } = await import('../src/main/tasks/progressObservations.ts')
observeProgressEvent({ type: 'task-clarification-updated', request: { executionSessionId: 'exec-b', id: 'clar-b1', status: 'waiting_user' } })
await judgeTask(taskB.id, '场景2：B 等待用户决定（需行动通知）')
await judgeTask(taskA.id, '场景3：A 的常规进展（多任务上下文，digest 可选）')

const { flushTelemetry } = await import('../src/main/telemetry.ts')
await flushTelemetry()
await flushAll()
console.log('ROOT=' + process.env.OPENBOT_DATA_DIR)
