// Controlled Codex protocol fixture; its file operations really execute in Node.
// It never chooses task identity, starts a task, or impersonates a real model.
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const readline = require('node:readline')
const cfg = globalThis.__planningResultFixture
if (!cfg) throw new Error('A synthetic fixture root is required')
const { contract } = require(cfg.operation)
const args = process.argv.slice(2)
if (args.includes('--version')) { console.log('codex-cli 0.167.0'); process.exit(0) }
if (args[0] === 'login') { console.log('Logged in using ChatGPT'); process.exit(0) }
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
const trace = value => fs.appendFileSync(cfg.trace, JSON.stringify(value) + '\n')
const records = () => fs.readdirSync(cfg.data + '/tasks').filter(n => n.endsWith('.json')).map(n => JSON.parse(fs.readFileSync(cfg.data + '/tasks/' + n)))
const current = () => records().find(t => t.status === 'running' && t.workspace?.path === process.cwd())
const active = new Map()
let sequence = 0
const owner = process.ppid
setInterval(() => { try { process.kill(owner, 0) } catch { process.exit(0) } }, 250).unref()

function finish(thread, interrupted = false) {
  const item = active.get(thread)
  if (!item) return
  clearInterval(item.timer); active.delete(thread)
  let receipt, error
  if (!interrupted) {
    try {
      const request = item.task.prompt + '\n' + JSON.stringify(item.task.plan?.context || {})
      for (const literal of [contract.relativePath, contract.timeZone]) {
        if (!request.includes(literal)) throw new Error('The delegated task omitted a required synthetic contract value: ' + literal)
      }
      for (const mode of ['write', 'read']) {
        const argv = [cfg.operation, mode, cfg.root]
        const id = 'operation-' + item.turn + '-' + mode
        const command = JSON.stringify([cfg.node, ...argv])
        send({ method: 'item/started', params: { threadId: thread, item: { id, type: 'commandExecution', command, cwd: process.cwd(), status: 'inProgress' } } })
        const started = Date.now()
        // Deliberately exclude all CLI homes, identity, proxy and credential env.
        const result = spawnSync(cfg.node, argv, { cwd: process.cwd(), env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', HOME: path.join(cfg.root, 'home'), TMPDIR: path.join(cfg.root, 'tmp') }, encoding: 'utf8', timeout: 10000 })
        const output = (result.stdout || '') + (result.stderr || '')
        send({ method: 'item/completed', params: { threadId: thread, item: { id, type: 'commandExecution', command, cwd: process.cwd(), status: result.status === 0 ? 'completed' : 'failed', exitCode: result.status, durationMs: Date.now() - started, aggregatedOutput: output } } })
        trace({ method: 'operation', taskId: item.task.id, mode, command, exitCode: result.status, output })
        if (result.status !== 0) throw new Error('Controlled file operation failed: ' + output)
        receipt = JSON.parse(result.stdout)
      }
    } catch (e) { error = e.message }
  }
  const status = interrupted ? 'interrupted' : error ? 'failed' : 'completed'
  const text = receipt && !error
    ? '受控合成负载已实际写入并独立回读唯一文档。文件：' + receipt.path + '。SHA-256：' + receipt.sha256 + '。三个标题：' + receipt.headings.join('；') + '。字段：' + receipt.fields.join('、') + '。时区：' + receipt.timeZone + '。完全虚构的样例：' + JSON.stringify(receipt.sample) + '。写入和回读两个实际 Node 子进程均退出 0，操作记录在同一执行会话。仅完成合成任务流验收，不代表真实业务实现。'
    : interrupted ? '合成执行已中断，没有新的交付。' : '合成负载失败，未声明完成：' + error
  send({ method: 'item/started', params: { threadId: thread, item: { id: 'answer-' + item.turn, type: 'agentMessage', phase: 'final_answer', text: '' } } })
  send({ method: 'item/agentMessage/delta', params: { threadId: thread, itemId: 'answer-' + item.turn, delta: text } })
  trace({ method: 'finish', taskId: item.task.id, status, receipt, error })
  send({ method: 'turn/completed', params: { threadId: thread, turn: { id: item.turn, status, items: [] } } })
}

readline.createInterface({ input: process.stdin }).on('line', line => {
  const r = JSON.parse(line), p = r.params || {}
  if (r.method === 'initialize') return send({ id: r.id, result: {} })
  if (r.method === 'model/list') return send({ id: r.id, result: { data: [{ model: 'fixture-worker', displayName: 'Controlled file workload' }], nextCursor: null } })
  if (r.method === 'thread/start' || r.method === 'thread/resume') return send({ id: r.id, result: { approvalsReviewer: p.approvalsReviewer ?? 'user', approvalPolicy: p.approvalPolicy ?? 'never', sandbox: { type: p.sandbox === 'workspace-write' ? 'workspaceWrite' : 'readOnly', networkAccess: false }, thread: { id: p.threadId ?? 'result-worker-' + (++sequence) } } })
  if (r.method === 'turn/start') {
    const task = current()
    if (!task) return send({ id: r.id, error: { code: -1, message: 'No assigned synthetic task' } })
    const item = { task, turn: 'turn-' + (++sequence) }
    active.set(p.threadId, item); trace({ method: 'start', taskId: task.id, cwd: process.cwd() })
    send({ id: r.id, result: { turn: { id: item.turn } } })
    send({ method: 'turn/started', params: { threadId: p.threadId, turn: { id: item.turn } } })
    item.timer = setInterval(() => {
      try { if (JSON.parse(fs.readFileSync(cfg.control, 'utf8'))[task.id]) finish(p.threadId) }
      catch (e) { clearInterval(item.timer); active.delete(p.threadId); trace({ method: 'fixture-error', error: e.message }); send({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id: item.turn, status: 'failed', items: [] } } }) }
    }, 80)
    return
  }
  if (r.method === 'turn/interrupt') { send({ id: r.id, result: {} }); return finish(p.threadId, true) }
  if (r.id) send({ id: r.id, result: {} })
})
