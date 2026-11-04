import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CLI_CATALOG } from '../../shared/cliCatalog.ts'
import { filterCatalog, PROVIDER_CATALOG } from '../../shared/providerCatalog.ts'
import { KNOWN_BACKEND_IDS } from '../settingsSchema.ts'
import { ANTHROPIC_DEFAULT_BASE_URL } from './anthropic.ts'
import { OPENAI_DEFAULT_BASE_URL } from './openai.ts'
import { OPENROUTER_DEFAULT_BASE_URL } from './openrouter.ts'
import { XAI_DEFAULT_BASE_URL } from './xai.ts'

test('the provider catalog is searchable and every row is a known backend', () => {
  const ids = PROVIDER_CATALOG.map((entry) => entry.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.ok(ids.length >= 20)
  for (const id of ids) assert.ok(KNOWN_BACKEND_IDS.includes(id), id)
  assert.equal(PROVIDER_CATALOG.find((entry) => entry.id === 'openai')?.baseUrl, OPENAI_DEFAULT_BASE_URL)
  assert.equal(PROVIDER_CATALOG.find((entry) => entry.id === 'anthropic')?.baseUrl, ANTHROPIC_DEFAULT_BASE_URL)
  assert.equal(PROVIDER_CATALOG.find((entry) => entry.id === 'xai')?.baseUrl, XAI_DEFAULT_BASE_URL)
  assert.equal(PROVIDER_CATALOG.find((entry) => entry.id === 'openrouter')?.baseUrl, OPENROUTER_DEFAULT_BASE_URL)
  assert.deepEqual(
    filterCatalog(PROVIDER_CATALOG, '深度求索').map((entry) => entry.id),
    ['deepseek']
  )
  assert.ok(filterCatalog(PROVIDER_CATALOG, '智谱').some((entry) => entry.id === 'zhipu'))
})

test('the CLI catalog matches runnable local CLIs and can be searched', () => {
  for (const cli of CLI_CATALOG) assert.ok(KNOWN_BACKEND_IDS.includes(cli.id), cli.id)
  assert.deepEqual(
    filterCatalog(CLI_CATALOG, '月之暗面').map((entry) => entry.id),
    ['kimi']
  )
})
