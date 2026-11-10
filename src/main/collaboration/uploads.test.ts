import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises'
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
    await unlink(file!.path!)
    assert.throws(() => remoteAttachments('device-one', input), error => error instanceof Error && error.message.includes('Choose it again'))
    assert.throws(() => remoteAttachments('device-one', [{ id: 'a', name: 'x', kind: 'image', mime: 'image/svg+xml', data: 'AAAA' }]), { status: 400 })
    await assert.rejects(uploadRemoteFile('device-one', { name: 'x', data: 'AAAA' }, () => false), { status: 401 })
  } finally { if (before === undefined) delete process.env.OPENBOT_DATA_DIR; else process.env.OPENBOT_DATA_DIR = before; await rm(root, { recursive: true, force: true }) }
})

test('multi-megabyte uploads do not overflow and images retain their device-bound bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'blinky-upload-large-')), before = process.env.OPENBOT_DATA_DIR
  process.env.OPENBOT_DATA_DIR = root
  try {
    const bytes = Buffer.alloc(6 * 1024 * 1024, 65)
    const ref = await uploadRemoteFile('large-device', { name: 'large.txt', data: bytes.toString('base64') }, () => true)
    const [file] = remoteAttachments('large-device', [{ id: 'large', kind: 'file', name: 'large', path: ref }])
    assert.equal((await readFile(file.path!)).byteLength, bytes.byteLength)
    const photo = await uploadRemoteFile('photo-device', { name: 'photo.png', data: 'AQIDBA==' }, () => true)
    const [image] = remoteAttachments('photo-device', [{ id: 'image', kind: 'image', name: 'photo', mime: 'image/png', path: photo }])
    assert.equal(image.kind, 'image'); assert.equal(image.data, 'AQIDBA=='); assert.equal(image.path, undefined)
    assert.throws(() => remoteAttachments('other-device', [{ id: 'image', kind: 'image', name: 'photo', mime: 'image/png', path: photo }]), { status: 403 })
    for (const data of ['A===', 'AA=A', 'AAAA====', '!!AA', 'AAA']) await assert.rejects(uploadRemoteFile('x', { name: 'x', data }, () => true), { status: 400 })
    await assert.rejects(uploadRemoteFile('large-device', { name: 'large', data: Buffer.alloc(bytes.length + 1).toString('base64') }, () => true), { status: 400 })
  } finally { if (before === undefined) delete process.env.OPENBOT_DATA_DIR; else process.env.OPENBOT_DATA_DIR = before; await rm(root, { recursive: true, force: true }) }
})
