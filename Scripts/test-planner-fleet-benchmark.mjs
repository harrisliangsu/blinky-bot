// Planner fleet effect benchmark: does the injected task-fleet view improve
// multi-goal decomposition quality on the real model?
//
//   node --experimental-transform-types --import ./scripts/register-ts.mjs Scripts/test-planner-fleet-benchmark.mjs [--fleet-off]
//
// Metrics per scenario: dependency declaration correctness (real deps named,
// no false deps), action correctness, and workspace-conflict awareness.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { runCodexAppServer, stopWarmCodex } from '../src/main/backends/cli/codexAppServer.ts'
import { matchTaskCandidates } from '../src/main/tasks/matching.ts'
import { taskPlanningInstructions } from '../src/main/agent/taskPlanningPrompt.ts'
import { parseTaskPlan } from '../src/main/tasks/planning.ts'
import { flushAll } from '../src/main/store/jsonStore.ts'

const root = process.env.BLINKY_FLEET_MODEL_ROOT
assert.ok(root, 'Set a new isolated evidence directory')
await fs.mkdir(root, { recursive: true })
process.env.OPENBOT_DATA_DIR = path.join(root, 'app-data')

const mkTask = (id, title, status = 'running', extra = {}) => ({
  id, botId: 'bot', sourceSessionId: 'home', sessionId: 'execution-' + id, title, prompt: title, status, createdAt: 1, updatedAt: 2,
  plan: parseTaskPlan({ context: { summary: title, categories: ['功能开发'], scope: ['src/' + id], boundaries: [] }, ...(extra.planPatch ?? {}) }, root, 'home', 'bot', []),
  ...extra
})

const scenarios = [
  {
    id: 'prereq_chain', text: '拿报表甲的最终 CSV 作为唯一输入，生成一份数据质量报告乙。甲的 CSV 还没完全产出，乙不修改导出模块',
    fleet: [mkTask('jia', '报表甲导出', 'running')],
    expect: (answer) => ({ actionOk: answer?.action === 'new', depOk: Array.isArray(answer?.plan?.depends_on) && answer.plan.depends_on.includes('jia'), noFalseDep: (answer?.plan?.depends_on ?? []).filter((d) => d !== 'jia').length === 0 })
  },
  {
    id: 'parallel_independent', text: '新增两个完全独立的交付：丙设置界面和丁日志接口，两者没有输入输出关系，可以并行',
    fleet: [mkTask('wu', '无关的部署任务', 'running')],
    expect: (answer) => ({ actionOk: answer?.action === 'new', depOk: true, noFalseDep: !(answer?.plan?.depends_on ?? []).length })
  },
  {
    id: 'no_false_dep', text: '做戊数据缓存。注意：己的通知中心正在跑，但它和缓存没有输入输出关系',
    fleet: [mkTask('ji', '通知中心', 'running')],
    expect: (answer) => ({ actionOk: answer?.action === 'new', depOk: true, noFalseDep: !(answer?.plan?.depends_on ?? []).includes('ji') })
  },
  {
    id: 'workspace_conflict', text: '给导出视图加筛选栏，必须修改 src/export/View.tsx。庚正在做导出组件改造（同一工作区），接口约定还没确认',
    fleet: [mkTask('geng', '导出组件改造', 'running', { workspace: { strategy: 'worktree', path: root + '/ws/export' } })],
    expect: (answer) => {
      const reason = JSON.stringify(answer ?? {})
      return { actionOk: ['coordinate', 'message', 'new'].includes(answer?.action), depOk: true, noFalseDep: true, conflictAware: answer?.action === 'coordinate' || /冲突|同一文件|接口|边界/.test(reason) }
    }
  }
]

const fleetOn = !process.argv.includes('--fleet-off')
const system = taskPlanningInstructions + `
This is a text-only evaluation. Do not call any tools or execute anything. The match result below is complete synthetic data; fleet, when present, is your current active task list. Decide the owning Bot's action and, for a new task, write its plan. Return JSON only: {"action":"message|continue|new|coordinate|confirm_resume|wait","task_id":string?,"plan":{"depends_on":string[],"context":{"summary":string,"categories":string[],"scope":string[],"boundaries":string[]}}?}`

async function askModel(messages) {
  let output = '', final = ''
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 120000)
  try {
    for await (const chunk of runCodexAppServer({
      binaryPath: process.env.BLINKY_CODEX_BINARY || path.join(process.env.HOME, '.local/bin/codex'),
      ctx: { cwd: root, model: 'default', extraArgs: [] },
      req: { model: 'default', cwd: root, messages, tools: [], coordinatorOnly: true, restrictNativeWrites: true, readOnly: true, captureAgentTrace: false, signal: controller.signal, sessionKey: 'fleet-bench-' + randomUUID(), approve: async () => 'reject' }
    })) {
      if (chunk.type === 'text') { output += chunk.delta; if (chunk.segment?.phase === 'final_answer') final += chunk.delta }
    }
  } finally { clearTimeout(timer) }
  const selected = final || output
  try { return JSON.parse(selected.slice(selected.indexOf('{'), selected.lastIndexOf('}') + 1)) } catch { return null }
}

const results = []
for (const scenario of scenarios) {
  const runtime = { sessionId: 'home', botId: 'bot', executor: false, sourceCwd: root, sessionBusy: () => false, interrupted: () => false }
  if (fleetOn) runtime.fleet = async () => scenario.fleet.map((t) => ({ taskId: t.id, title: t.title, status: t.status, phase: t.status, dependsOn: t.plan?.dependencies ?? [], workspace: t.workspace?.path }))
  const match = await matchTaskCandidates([], { action: 'match', text: scenario.text }, runtime)
  const answer = await askModel([
    { role: 'system', content: system },
    { role: 'user', content: JSON.stringify(match) }
  ])
  const checks = scenario.expect(answer)
  results.push({ id: scenario.id, answer, ...checks })
}
const summary = {
  mode: fleetOn ? 'fleet-on' : 'fleet-off',
  scenarios: results.length,
  actionAccuracy: results.filter((r) => r.actionOk).length / results.length,
  dependencyAccuracy: results.filter((r) => r.depOk).length / results.length,
  falseDepFree: results.filter((r) => r.noFalseDep).length / results.length,
  conflictAware: results.filter((r) => r.conflictAware ?? true).filter(Boolean).length / results.length
}
await fs.writeFile(path.join(root, 'metrics.json'), JSON.stringify({ summary, results }, null, 2))
console.log(JSON.stringify({ ok: true, ...summary }))
stopWarmCodex()
await flushAll()
