import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentTask } from '../../shared/types.ts'
import { continuationError, taskReviewObjective } from './taskContinuation.ts'

const task: AgentTask = { id: 'one', botId: 'bot', sessionId: 'private', sourceSessionId: 'source', title: 'work', prompt: 'work', status: 'completed', createdAt: 1, updatedAt: 1, executionAgent: { backendId: 'codex', modelId: 'model' } }

test('a returned task can only continue once in its own conversation and bot', () => {
  assert.equal(continuationError(task, [task], 'source', 'bot', 'bot'), null)
  assert.ok(continuationError(task, [task], 'other', 'bot', 'bot'))
  assert.ok(continuationError(task, [task], 'source', 'bot', 'other'))
  assert.ok(continuationError({ ...task, status: 'cancelled' }, [task], 'source', 'bot', 'bot'))
  assert.equal(continuationError({ ...task, status: 'cancelled' }, [task], 'source', 'bot', 'bot', true), null)
  assert.ok(continuationError({ ...task, status: 'running' }, [task], 'source', 'bot', 'bot', true))
  assert.ok(continuationError({ ...task, status: 'running' }, [task], 'source', 'bot', 'bot'))
  assert.ok(continuationError(task, [task, { ...task, id: 'two', continuedFromTaskId: task.id }], 'source', 'bot', 'bot'))
})

test('a teammate task can resume only for its original lead and conversation', () => {
  const teammate: AgentTask = { ...task, botId: 'teammate', requesterBotId: 'bot', executionAgent: undefined }
  assert.equal(continuationError(teammate, [teammate], 'source', 'bot', 'bot'), null)
  assert.equal(continuationError(teammate, [teammate], 'source', 'bot', 'teammate'), null)
  assert.ok(continuationError(teammate, [teammate], 'source', 'teammate', 'teammate'))
  assert.ok(continuationError(teammate, [teammate], 'other', 'bot', 'bot'))
  assert.ok(continuationError(teammate, [teammate], 'source', 'bot', 'foreign'))
})

test('a multi-step continuation reviews the original objective after task records are reloaded', () => {
  const first = { ...task, prompt: 'Create and verify the requested report.' }
  const second = { ...task, id: 'two', continuedFromTaskId: first.id, prompt: 'Complete the missing analysis.' }
  const third = { ...task, id: 'three', continuedFromTaskId: second.id, prompt: 'Verify the report.' }
  const reloaded = JSON.parse(JSON.stringify([first, second, third])) as AgentTask[]
  assert.equal(taskReviewObjective(reloaded[2]!, reloaded), 'Original delegated objective:\nCreate and verify the requested report.\n\nContinuation instructions in order:\n1. Complete the missing analysis.\n\n2. Verify the report.')
  assert.equal(taskReviewObjective(first, [first]), first.prompt)
  assert.throws(() => taskReviewObjective(third, [third, first]), /incomplete or inconsistent/)
  assert.throws(() => taskReviewObjective(third, [third, { ...second, sessionId: 'other' }, first]), /incomplete or inconsistent/)
  assert.throws(() => taskReviewObjective(third, [{ ...third, continuedFromTaskId: 'two' }, { ...second, continuedFromTaskId: 'three' }]), /cycle/)
  assert.throws(() => taskReviewObjective({ ...first, prompt: '' }, [first]), /objective is unavailable/)
})
