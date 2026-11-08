// Text-only semantic probe through the real native Codex adapter.
// It sees synthetic candidate facts, not user files or real task transcripts.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { runCodexAppServer, stopWarmCodex } from '../src/main/backends/cli/codexAppServer.ts'
import { matchTaskCandidates } from '../src/main/tasks/matching.ts'
import { parseTaskPlan } from '../src/main/tasks/planning.ts'
import { taskPlanningInstructions } from '../src/main/agent/taskPlanningPrompt.ts'
import { flushAll } from '../src/main/store/jsonStore.ts'

const root = process.env.BLINKY_PLANNING_MODEL_ROOT
assert.ok(root, 'Set a new isolated evidence directory')
await fs.mkdir(root, { recursive: true })
process.env.OPENBOT_DATA_DIR = path.join(root, 'app-data')
const make = (id, summary, scope, status = 'running', extra = {}) => ({
  id, botId: 'bot', sourceSessionId: 'home', sessionId: 'execution-' + id, executionAgent: { backendId: 'codex', modelId: 'fixture-worker' },
  title: '优化导出与界面', prompt: summary, status, createdAt: 1, updatedAt: 2,
  plan: parseTaskPlan({ context: { summary, categories: ['功能开发'], scope, boundaries: ['只改所属模块；不发布'] } }, root, 'home', 'bot', []), ...extra
})
const csv = make('csv-test', '项目甲测试环境导出CSV，保留原验收目标', ['project-a/test', 'src/export'])
const pdf = make('pdf-prod', '项目乙正式环境导出PDF，属于另一个项目', ['project-b/prod', 'src/pdf'], 'completed')
const total = make('overall', '总任务负责远程界面和任务进度通信，任务规划模块不在其修改范围', ['src/remote', 'src/tasks/progress'])
const raw = [
  { id: 'active_same_goal', text: '项目甲测试CSV导出再加时区支持，已有执行者正在做', tasks: [csv, pdf], expected: 'message', target: csv.id },
  { id: 'returned_same_goal', text: '项目甲CSV导出返回了，补完时区核验，沿用它已保留的成果', tasks: [{ ...csv, status: 'completed' }, pdf], expected: 'continue', target: csv.id },
  { id: 'similar_title_other_project', text: '这次做项目丙生产环境的PDF模板，交付独立结果，与甲乙没有输入依赖', tasks: [csv, pdf], expected: 'new' },
  { id: 'parallel_split', text: '另一个独立范围：为同一个总目标实现任务规划机制，远程界面与进度通信继续由原执行者负责。规划模块可并行，拆出的范围要同步给总任务', tasks: [total], expected: 'new', parent: total.id },
  { id: 'real_prerequisite', text: '拿项目甲任务最终生成的CSV作为唯一输入，再独立生成一个数据报告。目前CSV还没有产出，报告不修改导出模块', tasks: [csv], expected: 'new', depends: csv.id },
  { id: 'known_file_conflict', text: '新增独立交付：导出组件视觉规范，必须改 src/export/View.tsx。已有CSV执行者明确正在改这个同一个文件，接口约定尚未确认。先协调具体文件边界，再决定是否可以并行', tasks: [{ ...csv, plan: { ...csv.plan, context: { ...csv.plan.context, scope: ['src/export/View.tsx'] } } }], expected: 'coordinate', target: csv.id },
  { id: 'stopped_no_bypass', text: '继续完成项目甲CSV任务的原目标', tasks: [{ ...csv, status: 'cancelled' }], expected: 'confirm_resume', target: csv.id },
  { id: 'returned_executor_busy', text: '项目甲CSV刚返回，继续在同一执行会话核验它的输出；此执行器当前仍忙于清理上一轮', tasks: [{ ...csv, status: 'completed' }], busy: true, expected: 'wait', target: csv.id }
]
const cases = raw.map(({ id, text, tasks, busy }) => ({
  id, ...matchTaskCandidates(tasks, { action: 'match', text }, { sessionId: 'home', botId: 'bot', executor: false, sourceCwd: root, sessionBusy: sessionId => Boolean(busy || tasks.some(task => task.sessionId === sessionId && task.status === 'running')), interrupted: () => false })
}))
const messages = [
  { role: 'system', content: taskPlanningInstructions + '\nThis is a text-only evaluation. Do not call any tools, run commands, inspect files, access URLs or send messages. Candidate facts are synthetic and complete. Only decide what the owning Bot should do; do not execute it. Return JSON only as an array of {id,action,task_id?,parent_task_id?,depends_on?,reason}. Actions: message, continue, new, coordinate (resolve known integration/file ownership first), confirm_resume (retain existing recovery gate), wait (same executor unavailable). Supply exact task IDs when relevant. Use an empty depends_on array when no true prerequisite exists.' },
  { role: 'user', content: JSON.stringify(cases) }
]
await fs.writeFile(path.join(root, 'input.json'), JSON.stringify(messages, null, 2))
let output = '', final = '', traces = 0
const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 180000), started = performance.now()
try {
  for await (const chunk of runCodexAppServer({
    binaryPath: process.env.BLINKY_CODEX_BINARY || path.join(process.env.HOME, '.local/bin/codex'),
    ctx: { cwd: root, model: 'default', extraArgs: [] },
    req: { model: 'default', cwd: root, messages, tools: [], coordinatorOnly: true, restrictNativeWrites: true, readOnly: true, captureAgentTrace: true, signal: controller.signal, sessionKey: 'planning-probe-' + randomUUID(), approve: async () => 'reject' }
  })) {
    if (chunk.type === 'text') { output += chunk.delta; if (chunk.segment?.phase === 'final_answer') final += chunk.delta }
    if (chunk.type === 'agent_trace' || chunk.type === 'tool_call') traces++
  }
  await fs.writeFile(path.join(root, 'output.txt'), output)
  const selected = final || output, json = selected.slice(selected.indexOf('['), selected.lastIndexOf(']') + 1)
  const answers = JSON.parse(json)
  for (const scenario of raw) {
    const answer = answers.find(value => value.id === scenario.id)
    assert.equal(answer?.action, scenario.expected, scenario.id + ': ' + JSON.stringify(answer))
    if (scenario.target) assert.equal(answer.task_id, scenario.target, scenario.id)
    if (scenario.parent) assert.equal(answer.parent_task_id, scenario.parent, scenario.id)
    if (scenario.depends) assert.ok(answer.depends_on?.includes(scenario.depends), scenario.id)
    else if (answer.action === 'new') assert.deepEqual(answer.depends_on ?? [], [], scenario.id + ' must not invent a prerequisite')
  }
  assert.equal(traces, 0, 'Semantic probe must stay text only')
  const result = { ok: true, realNativeCodex: true, modelRequest: 'default', source: 'current-user-cli-default', semanticCases: raw.length, toolsExecuted: 0, elapsedMs: Math.round(performance.now() - started), answers }
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ ok: true, semanticCases: raw.length, result: path.join(root, 'result.json') }))
} catch (error) { await fs.writeFile(path.join(root, 'failure.json'), JSON.stringify({ error: error.stack, output }, null, 2)); throw error }
finally { clearTimeout(timer); controller.abort(); stopWarmCodex(); await flushAll() }
