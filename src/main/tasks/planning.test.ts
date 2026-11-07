import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentTask } from '../../shared/types'
import { dependencyState, parseSavedTaskPlan, parseTaskPlan, rankQueuedTasks, validateDependencyGraph } from './planning.ts'
const task = (id: string, at = 1000): AgentTask => ({ id, botId: 'worker', requesterBotId: 'lead', sourceSessionId: 'source', sessionId: 'private-' + id, title: id, prompt: id, status: 'queued', createdAt: at, updatedAt: at })
const plan = (input: unknown = {}, tasks: AgentTask[] = []) => parseTaskPlan(input, '/tmp/source', 'source', 'lead', tasks)
test('the Bot chooses priority and workspace independently; shared work needs a reason and scoped dependencies', () => {
  const first = task('one'); first.status = 'completed'
  assert.equal(plan().workspace, 'auto')
  const chosen = plan({ priority: 'urgent', priority_reason: 'User changed the deadline', workspace: 'shared', workspace_reason: 'Consumes the first task’s output', depends_on: ['one'] }, [first])
  assert.equal(chosen.priority, 'urgent'); assert.deepEqual(chosen.dependencies, ['one'])
  assert.throws(() => plan({ workspace: 'shared' }), /reason/)
  assert.throws(() => plan({ depends_on: ['foreign'] }, [{ ...first, id: 'foreign', requesterBotId: 'other' }]), /belong/)
  assert.throws(() => plan({ priority: 'fake' }), /priority/)
  assert.throws(() => parseSavedTaskPlan({ ...chosen, sourceCwd: '../outside' }), /invalid/)
})
test('dependencies wait for completion, retain failed/cancelled dependencies, and reject cycles', () => {
  const first = task('one'), second = task('two'); second.plan = plan({ depends_on: ['one'] }, [first])
  assert.deepEqual(dependencyState(second, [first]), { ready: false, waiting: ['one'], failed: [] })
  assert.deepEqual(dependencyState(second, [{ ...first, status: 'failed' }]), { ready: false, waiting: [], failed: ['one'] })
  assert.equal(dependencyState(second, [{ ...first, status: 'completed' }]).ready, true)
  assert.throws(() => validateDependencyGraph('one', ['two'], [first, second]), /cycle/)
  validateDependencyGraph('three', ['two'], [first, second])
})
test('importance and waiting time govern queued work without preempting running tasks or starving old low-priority work', () => {
  const low = task('low', 0), urgent = task('urgent', 1_000_000), running = { ...task('running'), status: 'running' as const }
  low.plan = plan({ priority: 'low' }); urgent.plan = plan({ priority: 'urgent' })
  assert.equal(rankQueuedTasks([task('normal', 1_000_000), urgent, running], 1_000_000)[0]!.id, 'urgent')
  assert.equal(rankQueuedTasks([low, urgent], 1_000_000)[0]!.id, 'low')
  assert.ok(!rankQueuedTasks([running], 1_000_000).length)
  const one = task('one', 100), two = { ...task('two', 100), requesterBotId: 'other-lead' }
  assert.equal(rankQueuedTasks([one, two], 100, new Map([['lead', 50]]))[0]!.id, 'two')
})
