// Plan-gate effect benchmark: measures whether the host-side plan validation
// gate changes real-model first-pass plan quality and what the repair costs.
//
//   node --experimental-transform-types --import ./scripts/register-ts.mjs Scripts/test-plan-gate-benchmark.mjs [--gate-off]
//
// Default simulates the gate ON (a deficient first answer gets the ToolError
// and one repair round); --gate-off measures the un-gated baseline.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { runCodexAppServer, stopWarmCodex } from '../src/main/backends/cli/codexAppServer.ts'
import { matchTaskCandidates } from '../src/main/tasks/matching.ts'
import { taskPlanningInstructions } from '../src/main/agent/taskPlanningPrompt.ts'
import { parseTaskPlan } from '../src/main/tasks/planning.ts'
import { flushAll } from '../src/main/store/jsonStore.ts'

const root = process.env.BLINKY_PLANGATE_MODEL_ROOT
assert.ok(root, 'Set a new isolated evidence directory')
await fs.mkdir(root, { recursive: true })
process.env.OPENBOT_DATA_DIR = path.join(root, 'app-data')

const mkOther = (id) => ({
  id, botId: 'bot', sourceSessionId: 'home', sessionId: 'execution-' + id, title: '无关任务 ' + id, prompt: '别的模块的独立工作', status: 'running', createdAt: 1, updatedAt: 2,
  plan: parseTaskPlan({ context: { summary: '别的模块的独立工作', categories: ['杂项'], scope: ['src/' + id], boundaries: ['只改所属模块'] } }, root, 'home', 'bot', [])
})

const scenarios = [
  { id: 'pdf_export', text: '为报表系统新增 PDF 导出功能，只涉及导出侧，不动现有 CSV 和调度', scopeKeywords: ['导出', 'pdf'] },
  { id: 'twofactor', text: '给登录流程加双因素认证，不改现有会话管理和权限模型', scopeKeywords: ['登录', '双因素'] },
  { id: 'streaming', text: '把订单数据管道从每小时批处理改成实时流式处理，保持下游接口不变', scopeKeywords: ['订单', '实时', '流式'] },
  { id: 'darkmode', text: '为 macOS 客户端设置页新增深色模式切换，不动系统主题检测逻辑', scopeKeywords: ['深色', '主题'] },
  { id: 'cache_layer', text: '给商品查询加一层本地缓存，不改数据库表结构和现有查询接口', scopeKeywords: ['缓存', '查询'] },
  { id: 'audit_log', text: '为后台管理操作增加审计日志，只记录写操作，不改动业务逻辑', scopeKeywords: ['审计', '日志'] },
  { id: 'import_wizard', text: '做一个引导式的数据导入向导，替换现有的一次性导入脚本', scopeKeywords: ['导入', '向导'] },
  { id: 'notify_center', text: '新增通知中心聚合任务结果提醒，不改动现有单条通知的发送逻辑', scopeKeywords: ['通知'] }
]

const gateOn = !process.argv.includes('--gate-off')
const system = taskPlanningInstructions + `
This is a text-only evaluation. Do not call any tools or execute anything. The match result below is complete synthetic data. Decide the owning Bot's action and, for a new task, write its plan context. Return JSON only: {"action":"message|continue|new|coordinate|confirm_resume|wait","task_id":string?,"plan":{"context":{"summary":string,"categories":string[],"scope":string[],"boundaries":string[]}}?}`

async function askModel(messages) {
  let output = '', final = ''
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 120000)
  try {
    for await (const chunk of runCodexAppServer({
      binaryPath: process.env.BLINKY_CODEX_BINARY || path.join(process.env.HOME, '.local/bin/codex'),
      ctx: { cwd: root, model: 'default', extraArgs: [] },
      req: { model: 'default', cwd: root, messages, tools: [], coordinatorOnly: true, restrictNativeWrites: true, readOnly: true, captureAgentTrace: false, signal: controller.signal, sessionKey: 'plangate-bench-' + randomUUID(), approve: async () => 'reject' }
    })) {
      if (chunk.type === 'text') { output += chunk.delta; if (chunk.segment?.phase === 'final_answer') final += chunk.delta }
    }
  } finally { clearTimeout(timer) }
  const selected = final || output
  try { return { answer: JSON.parse(selected.slice(selected.indexOf('{'), selected.lastIndexOf('}') + 1)), calls: 1 } } catch { return { answer: null, calls: 1 } }
}

function deficient(answer) {
  const missing = []
  const context = answer?.plan?.context
  if (typeof context?.summary !== 'string' || context.summary.trim().length < 8) missing.push('context.summary naming the goal and expected result')
  if (!Array.isArray(context?.scope) || !context.scope.some((s) => typeof s === 'string' && s.trim())) missing.push('context.scope listing the concrete modules or paths being changed')
  if (!Array.isArray(context?.boundaries) || !context.boundaries.some((b) => typeof b === 'string' && b.trim())) missing.push('context.boundaries stating what is excluded')
  return missing
}

const results = []
let totalCalls = 0
for (const scenario of scenarios) {
  const match = await matchTaskCandidates([mkOther('other-' + scenario.id)], { action: 'match', text: scenario.text }, { sessionId: 'home', botId: 'bot', executor: false, sourceCwd: root, sessionBusy: () => false, interrupted: () => false })
  const messages = [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(match) }]
  const first = await askModel(messages)
  totalCalls += first.calls
  let answer = first.answer
  let repaired = false
  const firstMissing = deficient(answer)
  if (gateOn && firstMissing.length) {
    repaired = true
    messages.push({ role: 'assistant', content: JSON.stringify(answer) })
    messages.push({ role: 'user', content: `Tool error: Nothing was started. The plan is too vague to execute and review safely; missing ${firstMissing.join('; ')}. Re-send with a complete plan.context. Return JSON only.` })
    const second = await askModel(messages)
    totalCalls += second.calls
    answer = second.answer
  }
  const finalMissing = deficient(answer)
  const scope = Array.isArray(answer?.plan?.context?.scope) ? answer.plan.context.scope.join(' ') : ''
  results.push({
    id: scenario.id,
    actionOk: answer?.action === 'new',
    firstPassOk: firstMissing.length === 0,
    repaired,
    finalOk: finalMissing.length === 0,
    keywordHits: scenario.scopeKeywords.filter((k) => scope.toLowerCase().includes(k.toLowerCase())).length,
    keywordTotal: scenario.scopeKeywords.length
  })
}
const decomp = results
const summary = {
  mode: gateOn ? 'gate-on' : 'gate-off',
  scenarios: decomp.length,
  modelCalls: totalCalls,
  firstPassOkRate: decomp.filter((r) => r.firstPassOk).length / decomp.length,
  finalOkRate: decomp.filter((r) => r.finalOk).length / decomp.length,
  repairRate: decomp.filter((r) => r.repaired).length / decomp.length,
  actionNewRate: decomp.filter((r) => r.actionOk).length / decomp.length,
  keywordHitRate: decomp.reduce((n, r) => n + (r.keywordHits), 0) / decomp.reduce((n, r) => n + (r.keywordTotal), 0)
}
await fs.writeFile(path.join(root, 'metrics.json'), JSON.stringify({ summary, results }, null, 2))
console.log(JSON.stringify({ ok: true, ...summary }))
stopWarmCodex()
await flushAll()
