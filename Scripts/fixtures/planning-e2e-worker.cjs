// Deterministic workload only. Real planning remains in the native lead model.
const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')
const args = process.argv.slice(2)
if (args.includes('--version')) { console.log('codex-cli 0.167.0'); process.exit(0) }
if (args[0] === 'login') { console.log('Logged in using ChatGPT'); process.exit(0) }
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
const owner = process.ppid
setInterval(() => { try { process.kill(owner, 0) } catch { process.exit(0) } }, 250).unref()
let sequence = 0
const active = new Map()
const records = () => fs.readdirSync(process.env.BLINKY_E2E_DATA + '/tasks').filter(n => n.endsWith('.json')).map(n => JSON.parse(fs.readFileSync(process.env.BLINKY_E2E_DATA + '/tasks/' + n)))
const current = () => records().find(task => task.status === 'running' && task.workspace?.path === process.cwd())
const trace = value => fs.appendFileSync(process.env.BLINKY_E2E_TRACE, JSON.stringify(value) + '\n')
function finish(thread, status = 'completed') {
  const item = active.get(thread)
  if (!item) return
  clearInterval(item.timer); active.delete(thread)
  const file = path.join(process.cwd(), 'synthetic-result-' + item.task.id + '.md')
  if (status === 'completed') fs.writeFileSync(file, '# 合成执行结果\n\n' + item.task.prompt + '\n\n补充：\n' + item.supplements.join('\n') + '\n')
  const id = 'answer-' + item.turn
  send({ method: 'item/started', params: { threadId: thread, item: { id, type: 'agentMessage', phase: 'final_answer', text: '' } } })
  send({ method: 'item/agentMessage/delta', params: { threadId: thread, itemId: id, delta: '合成执行阶段已返回。产物：' + file + '。仅完成受控流程工作负载，主 Bot 请按原始目标核对，不要扩大真实业务结论。' } })
  trace({ method: 'finish', taskId: item.task.id, file, status })
  send({ method: 'turn/completed', params: { threadId: thread, turn: { id: item.turn, status, items: [] } } })
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const r = JSON.parse(line), p = r.params || {}
  if (r.method === 'initialize') return send({ id: r.id, result: {} })
  if (r.method === 'model/list') return send({ id: r.id, result: { data: [{ model: 'fixture-worker', displayName: 'Controlled workload' }], nextCursor: null } })
  if (r.method === 'thread/start' || r.method === 'thread/resume') return send({ id: r.id, result: { approvalsReviewer: p.approvalsReviewer ?? 'user', approvalPolicy: p.approvalPolicy ?? 'never', sandbox: { type: p.sandbox === 'workspace-write' ? 'workspaceWrite' : 'readOnly', networkAccess: false }, thread: { id: p.threadId ?? 'worker-' + process.pid + '-' + (++sequence) } } })
  if (r.method === 'turn/start') {
    const thread = p.threadId, turn = 'turn-' + (++sequence), task = current()
    if (!task) return send({ id: r.id, error: { code: -1, message: 'No assigned synthetic task' } })
    const item = { turn, task, supplements: [] }
    active.set(thread, item); trace({ method: 'start', taskId: task.id, cwd: process.cwd() })
    send({ id: r.id, result: { turn: { id: turn } } }); send({ method: 'turn/started', params: { threadId: thread, turn: { id: turn } } })
    send({ method: 'item/started', params: { threadId: thread, item: { id: 'progress-' + turn, type: 'agentMessage', phase: 'commentary', text: '' } } })
    send({ method: 'item/agentMessage/delta', params: { threadId: thread, itemId: 'progress-' + turn, delta: '合成执行器已开始，正在保留工作区等待阶段完成。' } })
    item.timer = setInterval(() => { try { if (JSON.parse(fs.readFileSync(process.env.BLINKY_E2E_CONTROL))[task.id]) finish(thread) } catch {} }, 80)
    return
  }
  if (r.method === 'turn/steer') {
    const item = active.get(p.threadId)
    if (item?.turn !== p.expectedTurnId) return send({ id: r.id, error: { code: -1, message: 'No active synthetic turn' } })
    const text = JSON.stringify(p.input)
    item.supplements.push(text); trace({ method: 'steer', taskId: item.task.id, text })
    return send({ id: r.id, result: { turnId: p.expectedTurnId } })
  }
  if (r.method === 'turn/interrupt') { send({ id: r.id, result: {} }); return finish(p.threadId, 'interrupted') }
  if (r.id) send({ id: r.id, result: {} })
})
