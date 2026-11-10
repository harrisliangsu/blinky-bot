import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deliverableEvidenceLine, deliverableEvidencePaths } from './completionContext.ts'

const task = (patch) => ({
  id: 't', botId: 'worker', requesterBotId: 'lead', sourceSessionId: 's', sessionId: 'x',
  title: 't', prompt: 'p', status: 'completed', createdAt: 1, updatedAt: 1, ...patch,
})

test('verified deliverable paths are deduplicated and rendered relative to the source directory', () => {
  const withReview = task({
    review: { outcome: 'complete_claimed', summary: 'done', evidence: [], recordedAt: 2, verifiedFiles: [{ path: '/proj/src/a.js' }, { path: '/proj/src/a.js' }, { path: '/proj/lib/b.js' }] },
    workspace: { strategy: 'shared', path: '/proj/src', sourceCwd: '/proj/src', manifest: '/m', createdAt: 1 },
  })
  assert.deepEqual(deliverableEvidencePaths(withReview), ['/proj/src/a.js', '/proj/lib/b.js'])
  assert.equal(deliverableEvidenceLine(withReview), '交付物（已在工作区核对）：a.js、b.js')
})

test('acceptance output files join reviewed files; nothing verified means no line', () => {
  const withAcceptance = task({
    acceptance: { root: '/proj', files: [{ path: 'out/report.txt' }] },
    workspace: { strategy: 'shared', path: '/proj', sourceCwd: '/proj', manifest: '/m', createdAt: 1 },
  })
  assert.equal(deliverableEvidenceLine(withAcceptance), '交付物（已在工作区核对）：out/report.txt')
  assert.equal(deliverableEvidenceLine(task({})), undefined)
})
