import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { test } from 'node:test'
import type { ProviderMessage } from '../types.ts'
import { flattenTranscript } from './transcript.ts'
import {
  backendSeesImages,
  claudeStreamInput,
  codexTurnItems,
  materializeCodexImages,
  turnImages
} from './cliImages.ts'

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function user(text: string, data?: string): ProviderMessage {
  if (!data) return { role: 'user', content: text }
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image', mime: 'image/png', data }
    ]
  }
}

test('a cold turn keeps images and a warm turn keeps only the newest user image', () => {
  const messages: ProviderMessage[] = [
    user('First', PNG),
    { role: 'assistant', content: 'Ack' },
    user('Second', PNG.replace('A', 'B').padEnd(PNG.length, 'A'))
  ]
  assert.equal(turnImages(messages, false).length, 2)
  assert.equal(turnImages(messages, true).length, 1)
  const latest = turnImages(messages, true)[0]
  assert.equal(latest?.mime, 'image/png')
  assert.match(latest?.data ?? '', /^iVBOR/)
})

test('codex turn input is text plus a local image path', () => {
  assert.deepEqual(codexTurnItems('Look', ['/tmp/shot.png']), [
    { type: 'text', text: 'Look' },
    { type: 'localImage', path: '/tmp/shot.png' }
  ])
})

test('materialized images are real files and cleanup removes them', async () => {
  const made = await materializeCodexImages([{ type: 'image', mime: 'image/png', data: PNG }])
  assert.equal(made.paths.length, 1)
  const info = await stat(made.paths[0])
  assert.equal(info.isFile(), true)
  const bytes = await readFile(made.paths[0])
  assert.equal(bytes.subarray(0, 4).toString('hex'), '89504e47')
  await made.cleanup()
  await assert.rejects(stat(made.paths[0]))
})

test('a junk image is not written and does not fail the empty case', async () => {
  const made = await materializeCodexImages([{ type: 'image', mime: 'image/png', data: 'not base64!!!' }])
  assert.deepEqual(made.paths, [])
  await made.cleanup()
})

test('claude stream input carries the image bytes', () => {
  const raw = claudeStreamInput('What is this?', [{ type: 'image', mime: 'image/jpeg', data: PNG }])
  assert.ok(raw)
  const parsed = JSON.parse(raw) as {
    type: string
    message: { content: Array<{ type: string; source?: { media_type: string; data: string } }> }
  }
  assert.equal(parsed.type, 'user')
  assert.equal(parsed.message.content[0]?.type, 'text')
  assert.equal(parsed.message.content[1]?.type, 'image')
  assert.equal(parsed.message.content[1]?.source?.media_type, 'image/jpeg')
  assert.equal(parsed.message.content[1]?.source?.data, PNG)
  assert.equal(claudeStreamInput('no image', []), null)
})

test('an inline transcript does not claim an earlier image was omitted', () => {
  const messages: ProviderMessage[] = [user('See this', PNG), { role: 'assistant', content: 'Ok' }, user('Next')]
  const omitted = flattenTranscript(messages)
  const inline = flattenTranscript(messages, { images: 'inline' })
  assert.match(omitted, /omitted/)
  assert.doesNotMatch(inline, /omitted/)
  assert.match(inline, /See this/)
  assert.match(inline, /Next/)
})

test('codex and claude still see images when the catalog has not loaded', () => {
  assert.equal(backendSeesImages('codex', null), true)
  assert.equal(backendSeesImages('claude', null), true)
  assert.equal(backendSeesImages('kimi', null), false)
  assert.equal(backendSeesImages('codex', { supportsVision: false }), false)
  assert.equal(backendSeesImages('openai', { supportsVision: true }), true)
})
