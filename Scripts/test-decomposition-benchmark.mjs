// Decomposition-quality benchmark: measures whether the planning experience
// library improves real-model plan structure on fixed synthetic scenarios.
//
//   node --experimental-transform-types --import ./scripts/register-ts.mjs Scripts/test-decomposition-benchmark.mjs [--seed]
//
// --seed pre-loads the experience store with relevant completed tasks
// (after-mode); the default empty store is the before-mode. Same scenarios,
// same retrieval code — the difference isolates the experience effect.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { runCodexAppServer, stopWarmCodex } from '../src/main/backends/cli/codexAppServer.ts'
import { matchTaskCandidates } from '../src/main/tasks/matching.ts'
import { taskPlanningInstructions } from '../src/main/agent/taskPlanningPrompt.ts'
import { capturePlanExperience, planExperienceReferences } from '../src/main/tasks/planExperience.ts'
import { parseTaskPlan } from '../src/main/tasks/planning.ts'
import { flushAll } from '../src/main/store/jsonStore.ts'

const root = process.env.BLINKY_DECOMPOSITION_MODEL_ROOT
assert.ok(root, 'Set a new isolated evidence directory')
await fs.mkdir(root, { recursive: true })
process.env.OPENBOT_DATA_DIR = path.join(root, 'app-data')

const mkTask = (id, title, prompt, status = 'running', extra = {}) => ({
  id, botId: 'bot', sourceSessionId: 'home', sessionId: 'execution-' + id,
  title, prompt, status, createdAt: 1, updatedAt: 2,
  plan: parseTaskPlan({ context: { summary: prompt, categories: ['功能开发'], scope: ['src/' + id], boundaries: ['只改所属模块；不发布'] } }, root, 'home', 'bot', []),
  ...extra
})

const decomp = [
  { id: 'pdf_export', text: '为报表系统新增 PDF 导出功能，只涉及导出侧，不动现有 CSV 和调度', expected: 'new', scopeKeywords: ['导出', 'pdf'] },
  { id: 'twofactor', text: '给登录流程加双因素认证，不改现有会话管理和权限模型', expected: 'new', scopeKeywords: ['登录', '双因素'] },
  { id: 'streaming', text: '把订单数据管道从每小时批处理改成实时流式处理，保持下游接口不变', expected: 'new', scopeKeywords: ['订单', '实时', '流式'] },
  { id: 'darkmode', text: '为 macOS 客户端设置页新增深色模式切换，不动系统主题检测逻辑', expected: 'new', scopeKeywords: ['深色', '主题'] }
]

const routing = [
  { id: 'route_message', text: '项目甲 CSV 导出再加时区支持，已有执行者正在做', tasks: [mkTask('csv-1', '项目甲CSV导出', '项目甲测试环境导出CSV', 'running')], expected: 'message', target: 'csv-1' },
  { id: 'route_continue', text: '项目甲 CSV 导出返回了，补完时区核验，沿用它已保留的成果', tasks: [mkTask('csv-2', '项目甲CSV导出', '项目甲测试环境导出CSV', 'completed')], expected: 'continue', target: 'csv-2' },
  { id: 'route_new', text: '做一次完全独立的内部文案审校，与现有工程任务无输入输出关系', tasks: [mkTask('csv-3', '项目甲CSV导出', '项目甲测试环境导出CSV', 'running')], expected: 'new' }
]

if (process.argv.includes('--seed')) {
  const seeds = [
    mkTask('exp-1', '报表导出加打印样式', '报表系统导出功能增加打印友好样式', 'completed'),
    mkTask('exp-2', '账号安全增强短信验证', '登录安全：密码之外增加短信二次验证', 'completed'),
    mkTask('exp-3', '库存批处理改增量同步', '库存数据从每日全量批处理改为增量同步管道', 'completed')
  ]
  for (const seed of seeds) await capturePlanExperience(seed)
}

const runtimeBase = { sessionId: 'home', botId: 'bot', executor: false, sourceCwd: root, sessionBusy: () => false, interrupted: () => false }
const withExperience = { ...runtimeBase, experience: (text, categories) => planExperienceReferences(text, categories) }
const noExperience = { ...runtimeBase, experience: () => Promise.resolve([]) }
const useExperience = process.argv.includes('--seed')

const system = taskPlanningInstructions + `
This is a text-only evaluation. Do not call any tools or execute anything. The match result below is complete synthetic data. Decide the owning Bot's action and, for a new task, write its plan context. Return JSON only: {"action":"message|continue|new|coordinate|confirm_resume|wait","task_id":string?,"plan":{"context":{"summary":string,"categories":string[],"scope":string[],"boundaries":string[]}}?}. For new tasks, scope must name the concrete modules/areas being changed and boundaries must state what is excluded.`

async function ask(matchPayload) {
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: JSON.stringify(matchPayload) }
  ]
  const selected = final || output
  const start = selected.indexOf('{'), end = selected.lastIndexOf('}')
  try { return JSON.parse(selected.slice(start, end + 1)) } catch {
    const retry = await askModel(messages, 'Return ONLY the JSON object, no prose, no markdown fences.')
    const r2 = retry.final || retry.output
    try { return JSON.parse(r2.slice(r2.indexOf('{'), r2.lastIndexOf('}') + 1)) } catch { return null }
  }
}

async function askModel(messages) {
  let output = '', final = ''
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 120000)
  try {
    for await (const chunk of runCodexAppServer({
      binaryPath: process.env.BLINKY_CODEX_BINARY || path.join(process.env.HOME, '.local/bin/codex'),
      ctx: { cwd: root, model: 'default', extraArgs: [] },
      req: { model: 'default', cwd: root, messages, tools: [], coordinatorOnly: true, restrictNativeWrites: true, readOnly: true, captureAgentTrace: false, signal: controller.signal, sessionKey: 'decomp-bench-' + randomUUID(), approve: async () => 'reject' }
    })) {
      if (chunk.type === 'text') { output += chunk.delta; if (chunk.segment?.phase === 'final_answer') final += chunk.delta }
    }
  } finally { clearTimeout(timer) }
  return { output, final }
}

const results = []
for (const scenario of decomp) {
  const match = await matchTaskCandidates([mkTask('other-' + scenario.id, '无关任务', '别的模块的独立工作', 'running')], { action: 'match', text: scenario.text }, useExperience ? withExperience : noExperience)
  const answer = await ask(match)
  const scope = Array.isArray(answer?.plan?.context?.scope) ? answer.plan.context.scope.join(' ') : ''
  const boundaries = Array.isArray(answer?.plan?.context?.boundaries) ? answer.plan.context.boundaries.join(' ') : ''
  results.push({
    id: scenario.id,
    actionOk: answer?.action === scenario.expected,
    planPresent: Boolean(answer?.plan?.context),
    scopeNonEmpty: scope.trim().length > 0,
    boundariesNonEmpty: boundaries.trim().length > 0,
    keywordHits: scenario.scopeKeywords.filter((k) => scope.toLowerCase().includes(k.toLowerCase())).length,
    keywordTotal: scenario.scopeKeywords.length,
    hadReferences: Boolean(match.decompositionReferences?.length)
  })
}
{
  const match = await matchTaskCandidates(routing.flatMap(s => s.tasks), { action: 'match', text: routing.map(r => r.id).join('|') }, useExperience ? withExperience : noExperience)
  const multi = await ask({ ...match, request: 'multi-scenario routing batch (see per-scenario texts in cases)', cases: routing.map(r => ({ id: r.id, text: r.text })) , note: match.note + ' The cases array lists additional goals; answer each by id.' })
  for (const scenario of routing) {
    const entry = Array.isArray(multi) ? multi.find((m) => m.id === scenario.id) : multi?.[scenario.id]
    results.push({ id: scenario.id, actionOk: entry?.action === scenario.expected, targetOk: scenario.target ? entry?.task_id === scenario.target : true })
  }
}

const summary = {
  mode: useExperience ? 'after(seeded)' : 'before(empty)',
  scenarios: results.length,
  actionAccuracy: results.filter(r => r.actionOk).filter(Boolean).length / results.length,
  decomp: results.filter(r => 'planPresent' in r)
}
summary.planPresentRate = summary.decomp.filter(r => r.planPresent).length / summary.decomp.length
summary.scopeNonEmptyRate = summary.decomp.filter(r => r.scopeNonEmpty).length / summary.decomp.length
summary.boundariesNonEmptyRate = summary.decomp.filter(r => r.boundariesNonEmpty).length / summary.decomp.length
summary.keywordHitRate = summary.decomp.reduce((n, r) => n + r.keywordHits, 0) / summary.decomp.reduce((n, r) => n + r.keywordTotal, 0)
await fs.writeFile(path.join(root, 'metrics.json'), JSON.stringify({ summary, results }, null, 2))
console.log(JSON.stringify({ ok: true, ...summary }))
stopWarmCodex()
await flushAll()
