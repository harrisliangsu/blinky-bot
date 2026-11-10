import assert from 'node:assert/strict'
import { test } from 'node:test'
import { gmailMime, validMailAddress } from './gmailMime.ts'

test('mail MIME preserves Unicode text and rejects injected headers', () => {
  const subject = '一段很长的中文主题🙂'.repeat(6), body = '你好\nThis is a fixture.'
  const mime = Buffer.from(gmailMime({ to:'test@example.com', subject, body }), 'base64url').toString('utf8')
  const [headers, encoded] = mime.split('\r\n\r\n')
  const words = [...headers!.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)]
  assert.equal(words.map((m) => Buffer.from(m[1]!, 'base64').toString('utf8')).join(''), subject)
  assert.equal(Buffer.from(encoded!.replace(/\r\n/g,''), 'base64').toString('utf8'), body)
  assert.ok(words.every((m) => m[0].length <= 75))
  assert.throws(() => gmailMime({ to:'test@example.com\r\nBcc: bad@example.com', subject:'x', body:'x' }), /Invalid mail headers/)
  assert.throws(() => gmailMime({ to:'test@example.com', subject:'x\r\nBcc: bad@example.com', body:'x' }), /Invalid mail headers/)
  assert.equal(validMailAddress('user@example.com'), true)
})
