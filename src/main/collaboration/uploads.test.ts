import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { uploadRemoteFile, remoteAttachments } from './uploads.ts'
test('uploaded paths are opaque, owner-bound, revoked-safe, and never authorize reading a host path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-upload-')), before = process.env.OPENBOT_DATA_DIR
  process.env.OPENBOT_DATA_DIR = root
  try {
    const ref = await uploadRemoteFile('device-one', { name: '../synthetic.txt', data: Buffer.from('Synthetic attachment').toString('base64') }, () => true)
    assert.ok(!ref.includes(root))
    const input = [{ id: 'att1', kind: 'file', name: 'claimed-name', path: ref }]
    const [file] = remoteAttachments('device-one', input)
    assert.equal(file!.name, 'synthetic.txt'); assert.equal(await readFile(file!.path!, 'utf8'), 'Synthetic attachment')
    assert.throws(() => remoteAttachments('device-two', input), { status: 403 })
    assert.throws(() => remoteAttachments('device-one', [{ ...input[0], path: '/etc/passwd' }]), { status: 403 })
    assert.throws(() => remoteAttachments('device-one', [{ id: 'a', name: 'x', kind: 'image', mime: 'image/svg+xml', data: 'AAAA' }]), { status: 400 })
    await assert.rejects(uploadRemoteFile('device-one', { name: 'x', data: 'AAAA' }, () => false), { status: 401 })
  } finally { if (before === undefined) delete process.env.OPENBOT_DATA_DIR; else process.env.OPENBOT_DATA_DIR = before; await rm(root, { recursive: true, force: true }) }
})
