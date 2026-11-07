import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TaskProgressMonitor, PROGRESS_QUIET_MS, PROGRESS_COALESCE_MS, type ProgressPorts, type ProgressSnapshot, type ProgressState } from './progressMonitor'
function fixture() {
  let now = 1_000_000
  const snapshots: ProgressSnapshot[] = [{ id: 'a', owner: 'source/lead/executor', title: 'synthetic objective', phase: 'queued', progress: 'empty', detail: '', terminal: false, needsAttention: true }]
  const disk = new Map<string, ProgressState>(), messages = new Map<string, string>(), errors: unknown[] = []
  let writes = 0, posts = 0, failWrite = false, failPost = false, failAck = false
  const ports: ProgressPorts = {
    snapshots: () => structuredClone(snapshots), now: () => now,
    read: async id => structuredClone(disk.get(id) ?? null),
    write: async (id, state) => { writes++; if (failWrite || failAck && !state.pending) throw Error('disk failure'); disk.set(id, structuredClone(state)) },
    post: async (s, n) => { posts++; if (failPost) throw Error('disconnect'); if (s.phase !== snapshots.find(v => v.id === s.id)?.phase) return false; messages.set(n.id, n.text); return true },
    error: (_id, e) => { errors.push(e) }
  }
  return { snapshots, disk, messages, errors, ports, monitor: new TaskProgressMonitor(ports), advance: (ms: number) => { now += ms }, get writes() { return writes }, get posts() { return posts }, failWrite: (v: boolean) => { failWrite = v }, failPost: (v: boolean) => { failPost = v }, failAck: (v: boolean) => { failAck = v } }
}
test('automatic lifecycle notices never claim objective completion; unchanged scans do no IO', async () => {
  const f = fixture(); await f.monitor.scan(); assert.match([...f.messages.values()][0]!, /排队/)
  f.snapshots[0]!.phase = 'running'; await f.monitor.scan(); assert.equal(f.messages.size, 2)
  const writes = f.writes, posts = f.posts
  for (let i = 0; i < 20; i++) await f.monitor.scan()
  assert.equal(f.writes, writes); assert.equal(f.posts, posts)
  Object.assign(f.snapshots[0]!, { phase: 'completed', terminal: true }); await f.monitor.scan()
  assert.match([...f.messages.values()].at(-1)!, /已返回结果.*待核对/)
  await f.monitor.scan(); assert.equal(f.messages.size, 3)
})
test('quiet work emits once per progress episode, survives restart, and never restarts the executor', async () => {
  const f = fixture(); f.snapshots[0]!.phase = 'running'; await f.monitor.scan()
  f.advance(PROGRESS_QUIET_MS); await f.monitor.scan(); assert.match([...f.messages.values()].at(-1)!, /暂未收到新进展/)
  for (let i = 0; i < 8; i++) { f.advance(PROGRESS_QUIET_MS); await f.monitor.scan() }
  assert.equal(f.messages.size, 2)
  await new TaskProgressMonitor(f.ports).scan(); assert.equal(f.messages.size, 2)
  f.snapshots[0]!.progress = 'milestone'; f.snapshots[0]!.detail = 'Agent 记录（尚未独立核验）：1/2'; await f.monitor.scan()
  f.advance(PROGRESS_QUIET_MS); await f.monitor.scan(); assert.equal(f.messages.size, 4)
})
test('todo burst coalesces while waits, failure and cancellation bypass the milestone interval', async () => {
  const f = fixture(); f.snapshots[0]!.phase = 'running'; await f.monitor.scan()
  f.snapshots[0]!.progress = 'one'; await f.monitor.scan(); assert.equal(f.messages.size, 1)
  f.snapshots[0]!.progress = 'two'; f.advance(PROGRESS_COALESCE_MS); await f.monitor.scan(); assert.equal(f.messages.size, 2)
  for (const phase of ['waiting_user', 'waiting_approval', 'waiting_help', 'reconnecting', 'running', 'failed', 'cancelled'] as const) {
    Object.assign(f.snapshots[0]!, { phase, terminal: ['failed', 'cancelled'].includes(phase) }); await f.monitor.scan()
  }
  assert.equal(f.messages.size, 9); assert.match([...f.messages.values()].at(-1)!, /已停止/)
})
test('outbox write precedes publishing, and a lost acknowledgement retries the same message after restart', async () => {
  const f = fixture(); f.failWrite(true); await f.monitor.scan(); assert.equal(f.messages.size, 0)
  f.failWrite(false); f.failPost(true); await f.monitor.scan(); assert.ok(f.disk.get('a')?.pending)
  f.failPost(false); f.failAck(true); await f.monitor.scan(); assert.equal(f.messages.size, 1); assert.ok(f.disk.get('a')?.pending)
  f.failAck(false); await new TaskProgressMonitor(f.ports).scan(); assert.equal(f.messages.size, 1); assert.equal(f.disk.get('a')?.pending, undefined)
})
test('cancel discards undelivered running notice and owner changes fail closed', async () => {
  const f = fixture(); f.failPost(true); await f.monitor.scan(); f.failPost(false)
  Object.assign(f.snapshots[0]!, { phase: 'cancelled', terminal: true }); await f.monitor.scan()
  assert.equal(f.messages.size, 1); assert.match([...f.messages.values()][0]!, /已停止/)
  f.snapshots[0]!.owner = 'different-source/different-bot'; await f.monitor.scan(); assert.equal(f.messages.size, 1); assert.ok(f.errors.length)
})
test('multiple tasks stay independent; historical settled work produces no replay', async () => {
  const f = fixture(); f.snapshots.push({ ...f.snapshots[0]!, id: 'b', phase: 'waiting_user' }, { ...f.snapshots[0]!, id: 'old', phase: 'completed', terminal: true, needsAttention: false })
  await Promise.all([f.monitor.scan(), f.monitor.scan(), f.monitor.scan()]); assert.equal(f.messages.size, 2)
  assert.ok([...f.messages.keys()].some(id => id.includes('-b-')))
})

test('a real reported milestone resets quiet tracking without repeating its already-delivered prose', async () => {
  const f = fixture(); f.snapshots[0]!.phase = 'running'; await f.monitor.scan()
  f.advance(PROGRESS_QUIET_MS - 1); f.snapshots[0]!.report = 'saved-report-one'; await f.monitor.scan()
  assert.equal(f.messages.size, 1)
  f.advance(2); await f.monitor.scan(); assert.equal(f.messages.size, 1)
  f.advance(PROGRESS_QUIET_MS); await f.monitor.scan(); assert.equal(f.messages.size, 2)
})
