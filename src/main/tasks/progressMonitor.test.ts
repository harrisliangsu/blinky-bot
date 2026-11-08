import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TaskProgressMonitor, type ProgressDecision, type ProgressPorts, type ProgressSnapshot, type ProgressState } from './progressMonitor'
function fixture() {
  const snapshots: ProgressSnapshot[] = [{ id: 'a', owner: 'source/lead/executor', title: 'synthetic objective', phase: 'running', progress: 'empty', detail: '', evidence: [], terminal: false, needsAttention: true }]
  const disk = new Map<string, ProgressState>(), messages = new Map<string, string>(), errors: unknown[] = []
  let writes = 0, posts = 0, judgments = 0, failWrite = false, failPost = false, failAck = false
  let decision: ProgressDecision | null = { kind: 'silent' }
  const ports: ProgressPorts = {
    snapshots: () => structuredClone(snapshots), read: async id => structuredClone(disk.get(id) ?? null),
    write: async (id, state) => { writes++; if (failWrite || failAck && !state.pending) throw Error('disk failure'); disk.set(id, structuredClone(state)) },
    judge: async () => { judgments++; return decision },
    post: async (s, n) => { posts++; if (failPost) throw Error('disconnect'); if (s.phase !== snapshots.find(v => v.id === s.id)?.phase) return false; messages.set(n.id, n.text); return true },
    error: (_id, e) => { errors.push(e) }
  }
  return { snapshots, disk, messages, errors, ports, monitor: new TaskProgressMonitor(ports), get writes() { return writes }, get posts() { return posts }, get judgments() { return judgments }, decision: (d: ProgressDecision | null) => { decision = d }, failWrite: (v: boolean) => { failWrite = v }, failPost: (v: boolean) => { failPost = v }, failAck: (v: boolean) => { failAck = v } }
}
test('no progress and ordinary todo/state changes stay silent, including recovery scans/restart', async () => {
  const f = fixture(); await f.monitor.scan()
  for (let i = 0; i < 20; i++) await f.monitor.scan()
  assert.equal(f.messages.size, 0); assert.equal(f.judgments, 0)
  Object.assign(f.snapshots[0]!, { progress: 'todo changed', evidence: [{ id: 'step', kind: 'report', text: 'one test passed' }] })
  await f.monitor.scan(); assert.equal(f.judgments, 1); assert.equal(f.messages.size, 0)
  await new TaskProgressMonitor(f.ports).scan(); assert.equal(f.judgments, 1)
})
test('the Bot decides a milestone without a minimum elapsed interval; repeats do no IO', async () => {
  const f = fixture(); await f.monitor.scan()
  Object.assign(f.snapshots[0]!, { progress: 'usable feature', evidence: [{ id: 'proof', kind: 'report', text: 'user outcome verified' }] })
  f.decision({ kind: 'milestone', text: '手机现在能上传图片了。', evidenceIds: ['proof'] }); await f.monitor.scan()
  assert.equal(f.messages.size, 1); const writes = f.writes
  await f.monitor.scan(); await new TaskProgressMonitor(f.ports).scan(); assert.equal(f.messages.size, 1); assert.equal(f.writes, writes)
})
test('unavailable judgment remains retryable; mandatory lifecycle is written by Bot, transient reconnect stays silent', async () => {
  const f = fixture(); f.decision(null); await f.monitor.scan()
  f.snapshots[0]!.phase = 'reconnecting'; await f.monitor.scan(); assert.equal(f.messages.size, 0)
  f.decision({ kind: 'milestone', text: 'Bot-generated status', evidenceIds: [] })
  for (const phase of ['waiting_user', 'waiting_approval', 'waiting_help', 'failed', 'cancelled'] as const) {
    Object.assign(f.snapshots[0]!, { phase, terminal: ['failed', 'cancelled'].includes(phase) }); await f.monitor.scan()
  }
  assert.equal(f.messages.size, 5); assert.match([...f.messages.values()].at(-1)!, /Bot-generated/)
})
test('outbox persists before publishing, lost acknowledgement retries the same message on restart', async () => {
  const f = fixture(); f.snapshots[0]!.phase = 'waiting_user'; f.decision({ kind: 'milestone', text: 'Bot-generated action', evidenceIds: [] }); f.failWrite(true); await f.monitor.scan(); assert.equal(f.messages.size, 0)
  f.failWrite(false); f.failPost(true); await f.monitor.scan(); assert.ok(f.disk.get('a')?.pending)
  f.failPost(false); f.failAck(true); await f.monitor.scan(); assert.equal(f.messages.size, 1); assert.ok(f.disk.get('a')?.pending)
  f.failAck(false); await new TaskProgressMonitor(f.ports).scan(); assert.equal(f.messages.size, 1); assert.equal(f.disk.get('a')?.pending, undefined)
})
test('cancel discards stale milestone; changed ownership fails closed; historical results do not replay', async () => {
  const f = fixture(); f.snapshots[0]!.phase = 'waiting_user'; f.decision({ kind: 'milestone', text: 'Bot-generated status', evidenceIds: [] }); f.failPost(true); await f.monitor.scan(); f.failPost(false)
  Object.assign(f.snapshots[0]!, { phase: 'cancelled', terminal: true }); await f.monitor.scan()
  assert.equal(f.messages.size, 1); assert.match([...f.messages.values()][0]!, /Bot-generated/)
  f.snapshots[0]!.owner = 'different-source'; await f.monitor.scan(); assert.equal(f.messages.size, 1); assert.ok(f.errors.length)
  f.snapshots.push({ ...f.snapshots[0]!, id: 'old', phase: 'completed', needsAttention: false }); await f.monitor.scan(); assert.equal(f.messages.size, 1)
})
test('a slow sibling judgment cannot delay a different task requiring user action', async () => {
  const f = fixture(); f.snapshots[0]!.evidence = [{id:'slow',kind:'report',text:'detail'}]
  f.snapshots.push({ ...f.snapshots[0]!, id:'b', phase:'waiting_help' })
  let release!: () => void; const gate = new Promise<void>(r => { release = r })
  f.ports.judge = async s => { if (s.id === 'a') await gate; return s.id === 'b' ? { kind: 'milestone', text: 'Bot-generated action', evidenceIds: [] } : { kind: 'silent' } }
  const scan = f.monitor.scan(); await new Promise(r => setTimeout(r, 10)); assert.ok([...f.messages.keys()].some(id => id.includes('-b-')))
  release(); await scan
})
test('a returned Agent stage is not automatically a user milestone or objective completion',async()=>{
 const f=fixture();await f.monitor.scan();Object.assign(f.snapshots[0]!,{phase:'completed',terminal:true,progress:'partial returned stage',evidence:[{id:'stage',kind:'report',text:'Initial input read; owning Bot still needs to choose next verification.'}]})
 f.decision({kind:'silent'});await f.monitor.scan();assert.equal(f.messages.size,0);assert.equal(f.judgments,1)
})
