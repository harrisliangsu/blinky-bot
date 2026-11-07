import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseAcceptance, parseSavedAcceptance, verifyAcceptance } from './acceptance.ts'
import { normaliseTask } from '../store/tasks.ts'

test('explicit output conditions are read-only, scoped, and do not disappear when invalid', async () => {
  const top = await mkdtemp(join(tmpdir(), 'blinky-acceptance-'))
  const root = join(top, 'workspace')
  await mkdir(root)
  try {
    const acceptance = parseAcceptance(root, [{ path: 'result.txt' }])
    await assert.rejects(verifyAcceptance(acceptance), /missing or inaccessible/)
    await writeFile(join(root, 'result.txt'), 'actual')
    const hash = createHash('sha256').update('actual').digest('hex')
    assert.deepEqual(await verifyAcceptance(acceptance), [{ path: 'result.txt', sha256: hash }])
    assert.equal((await verifyAcceptance(parseAcceptance(root, [{ path: 'result.txt', sha256: hash }])))[0]?.sha256, hash)
    await assert.rejects(verifyAcceptance(parseAcceptance(root, [{ path: 'result.txt', sha256: '0'.repeat(64) }])), /could not be verified/)
    const controller = new AbortController(); controller.abort()
    await assert.rejects(verifyAcceptance(acceptance, controller.signal), /stopped/)
    assert.throws(() => parseAcceptance(root, [{ path: '../outside' }]), /within the current workspace/)
    await writeFile(join(top, 'outside'), 'outside')
    await symlink(join(top, 'outside'), join(root, 'link'))
    await assert.rejects(verifyAcceptance(parseAcceptance(root, [{ path: 'link' }])), /outside the task workspace/)
    assert.equal(parseSavedAcceptance({ root, files: [{ path: '../outside' }] }), null)
    const task = normaliseTask({ id: '1', botId: 'bot', sessionId: 'session', status: 'completed', acceptance: { root, files: [{ path: '../outside' }] } })
    assert.equal(task?.acceptanceInvalid, true)
    const saved = normaliseTask({ id: '2', botId: 'bot', sessionId: 'session', status: 'completed', acceptance, review: { outcome: 'complete_claimed', summary: 'done', evidence: ['checked'], recordedAt: 1, verifiedFiles: acceptance.files } })
    assert.deepEqual(saved?.acceptance, acceptance)
    assert.deepEqual(saved?.review?.verifiedFiles, [{ path: 'result.txt' }])
  } finally { await rm(top, { recursive: true, force: true }) }
})
