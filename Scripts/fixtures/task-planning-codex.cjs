// Controlled executor for the packaged Preview test. No external work.
const readline = require('node:readline')
const fs = require('node:fs')
const args = process.argv.slice(2)
if (args.includes('--version')) { console.log('codex-cli 0.166.0'); process.exit(0) }
if (args[0] === 'login') { console.log('Logged in using ChatGPT'); process.exit(0) }
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
const owner = process.ppid
setInterval(() => { try { process.kill(owner, 0) } catch { process.exit(0) } }, 200).unref()
let sequence = 0
const active = new Map()
const finish = (thread, status = 'completed') => {
  const item = active.get(thread)
  if (!item) return
  clearInterval(item.timer); active.delete(thread)
  const id = 'answer-' + item.turn
  send({ method: 'item/started', params: { threadId: thread, item: { id, type: 'agentMessage', phase: 'final_answer', text: '' } } })
  send({ method: 'item/agentMessage/delta', params: { threadId: thread, itemId: id, delta: 'Controlled executor returned ' + item.tag } })
  send({ method: 'turn/completed', params: { threadId: thread, turn: { id: item.turn, status, items: [] } } })
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const r = JSON.parse(line), p = r.params || {}
  if (r.method === 'initialize') return send({ id: r.id, result: {} })
  if (r.method === 'model/list') return send({ id: r.id, result: { data: [{ model: 'fixture-lead', displayName: 'Fixture lead' }, { model: 'fixture-worker', displayName: 'Fixture worker' }], nextCursor: null } })
  if (r.method === 'thread/start' || r.method === 'thread/resume') return send({ id: r.id, result: { approvalsReviewer: p.approvalsReviewer ?? 'user', approvalPolicy: p.approvalPolicy ?? 'never', sandbox: { type: p.sandbox === 'workspace-write' ? 'workspaceWrite' : 'readOnly', networkAccess: false }, thread: { id: p.threadId ?? 'fixture-' + process.pid + '-' + (++sequence) } } })
  if (r.method === 'turn/start') {
    const thread = p.threadId, turn = 'turn-' + (++sequence), input = JSON.stringify(p.input || [])
    const tag = (input.match(/TEST_WORK_([A-Z]+)/) || [null, 'LEAD'])[1]
    active.set(thread, { turn, tag })
    send({ id: r.id, result: { turn: { id: turn } } })
    send({ method: 'turn/started', params: { threadId: thread, turn: { id: turn } } })
    send({ method: 'item/started', params: { threadId: thread, item: { id: 'progress-' + turn, type: 'agentMessage', phase: 'commentary', text: '' } } })
    send({ method: 'item/agentMessage/delta', params: { threadId: thread, itemId: 'progress-' + turn, delta: 'Controlled executor is running ' + tag } })
    if (p.model !== 'fixture-worker') return setTimeout(() => finish(thread), 20)
    active.get(thread).timer = setInterval(() => { try { if (JSON.parse(fs.readFileSync(process.env.BLINKY_PLANNING_CONTROL))[tag]) finish(thread) } catch {} }, 60)
    return
  }
  if (r.method === 'turn/steer') {
    if (active.get(p.threadId)?.turn !== p.expectedTurnId) return send({ id: r.id, error: { code: -1, message: 'No active fixture turn' } })
    return send({ id: r.id, result: { turnId: p.expectedTurnId } })
  }
  if (r.method === 'turn/interrupt') { send({ id: r.id, result: {} }); return finish(p.threadId, 'interrupted') }
  if (r.id) send({ id: r.id, result: {} })
})
