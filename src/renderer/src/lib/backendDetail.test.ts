/**
 * Backend status lines follow the settings language. English uses "an" before
 * OpenAI, Anthropic, xAI, and OpenRouter.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { needsKey } from '../../../main/backends/cloudDetect.ts'
import { localizeBackendDetail } from './backendDetail.ts'
import { settingsCopy } from './settingsCopy.ts'

const openai = needsKey('OpenAI', 'platform.openai.com/api-keys').detail ?? ''
const xai = needsKey('xAI', 'console.x.ai').detail ?? ''
const missing = '`opencode` was not found on your PATH. Install with `brew install opencode` or `npm i -g opencode-ai`.'

test('english provider lines use an before a vowel or x', () => {
  const copy = settingsCopy('en').backends.detail
  assert.match(localizeBackendDetail(openai, copy), /^API key required — add an OpenAI key/)
  assert.match(localizeBackendDetail(xai, copy), /add an xAI key/)
  assert.match(localizeBackendDetail(needsKey('Grok', 'example.test').detail ?? '', copy), /add a Grok key/)
  assert.equal(openai.includes('add a OpenAI'), false)
})

test('chinese settings restate the provider and CLI lines', () => {
  const copy = settingsCopy('zh-CN').backends.detail
  const key = localizeBackendDetail(openai, copy)
  const cli = localizeBackendDetail(missing, copy)
  assert.match(key, /请在设置里添加 OpenAI 的密钥/)
  assert.equal(key.includes('API key required'), false)
  assert.match(cli, /在 PATH 上找不到 `opencode`/)
  assert.match(cli, /可以用 `brew install opencode` 或 `npm i -g opencode-ai` 安装/)
  assert.equal(cli.includes('was not found'), false)
})

test('an unrecognised detail is left as the backend wrote it', () => {
  const raw = 'BlinkyBot will not send your OpenAI API key to example.test.'
  assert.equal(localizeBackendDetail(raw, settingsCopy('zh-CN').backends.detail), raw)
})
