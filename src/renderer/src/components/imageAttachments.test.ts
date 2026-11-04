import assert from 'node:assert/strict'
import { test } from 'node:test'
import { attachmentsFromImageFiles, filesFromTransfer, imagePreviewSrc, type ImageFileLike } from './imageAttachments.ts'

function fileLike(name: string, type: string, bytes: number[]): ImageFileLike {
  const data = Uint8Array.from(bytes)
  return {
    name,
    type,
    size: data.byteLength,
    lastModified: 1,
    arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
  }
}

test('a pasted screenshot becomes an image attachment with raw base64', async () => {
  const png = fileLike('shot.png', 'image/png', [0x89, 0x50, 0x4e, 0x47])
  const { attachments, skipped } = await attachmentsFromImageFiles([png], { now: 5 })
  assert.equal(skipped, 0)
  assert.equal(attachments.length, 1)
  assert.equal(attachments[0]?.kind, 'image')
  assert.equal(attachments[0]?.mime, 'image/png')
  assert.equal(attachments[0]?.name, 'shot.png')
  assert.equal(attachments[0]?.id, 'att-5-0')
  assert.equal(Buffer.from(attachments[0]?.data ?? '', 'base64').subarray(0, 4).toString('hex'), '89504e47')
})

test('clipboard items and the file list are not attached twice', () => {
  const png = fileLike('shot.png', 'image/png', [1, 2, 3, 4])
  const text = fileLike('notes.txt', 'text/plain', [1])
  const files = filesFromTransfer({
    files: [png, text],
    items: [{ kind: 'file', type: 'image/png', getAsFile: () => png }]
  })
  assert.equal(files.length, 1)
  assert.equal(files[0]?.name, 'shot.png')
})

test('an oversized image is skipped instead of truncated', async () => {
  const png = fileLike('big.png', 'image/png', [1, 2, 3, 4, 5, 6, 7, 8])
  const { attachments, skipped } = await attachmentsFromImageFiles([png], { maxDataLength: 4 })
  assert.equal(attachments.length, 0)
  assert.equal(skipped, 1)
})

test('a preview URL is only a safe raster image', () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  assert.match(imagePreviewSrc({ kind: 'image', mime: 'image/png', data: png }) ?? '', /^data:image\/png;base64,/)
  assert.equal(imagePreviewSrc({ kind: 'image', mime: 'image/svg+xml', data: png }), null)
  assert.equal(imagePreviewSrc({ kind: 'file', mime: 'image/png', data: png }), null)
})

test('a jpeg without a mime still attaches as jpeg', async () => {
  const jpg = fileLike('photo.jpg', '', [0xff, 0xd8, 0xff])
  const { attachments } = await attachmentsFromImageFiles([jpg], { now: 1 })
  assert.equal(attachments[0]?.mime, 'image/jpeg')
  assert.equal(attachments[0]?.name, 'photo.jpg')
})
