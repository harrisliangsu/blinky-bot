import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// Exercise the actual registry and MCP descriptors in Node without starting an
// Electron app. Electron itself is stubbed; the registry, schemas, mode filter,
// VM capability logic and descriptor authorization are the production modules.
const result = await build({
  stdin: {
    contents: `export { schemasFor } from './registry.ts'; export { describeTools, exposedSchema } from '../gateway/descriptors.ts'`,
    resolveDir: dirname(fileURLToPath(import.meta.url)), loader: 'ts'
  },
  bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 'no-electron', setup(builder) {
    builder.onResolve({ filter: /apps\/status$/ }, args => args.path === '../../apps/status' ? { path: 'account-status', namespace: 'account-status-stub' } : undefined)
    builder.onLoad({ filter: /.*/, namespace: 'account-status-stub' }, () => ({ contents: 'export const googleAccountStatuses=async()=>[]', loader: 'js' }))
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-stub' }))
    builder.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({ contents: 'export const app = {}; export const safeStorage = {}; export const BrowserWindow = {}; export const shell = {}; export const Notification = {}', loader: 'js' }))
  }}]
})
const { schemasFor, describeTools, exposedSchema } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`)
const names = (schemas) => schemas.map((item) => item.name)
const hostConnectors = [
  'github_comment_draft', 'watch_github_issue', 'search_gmail', 'read_gmail', 'gmail_draft',
  'calendar_event_draft', 'watch_gmail_query', 'create_webhook_routine', 'read_x_post',
  'x_post_draft', 'slack_message_draft', 'list_calendar_events'
  ,'list_google_accounts', 'watch_folder'
]

test('delegation adds task review and management, not account or routine capabilities', () => {
  assert.deepEqual(names(schemasFor(['delegate_task'])), ['delegate_task', 'review_task', 'manage_task', 'ask_user'])
  assert.deepEqual(names(describeTools(['delegate_task'])), ['delegate_task', 'review_task', 'manage_task', 'ask_user'])
  assert.equal(exposedSchema(['delegate_task'], 'manage_task')?.name, 'manage_task')
  assert.equal(exposedSchema([], 'manage_task'), undefined)
  for (const name of [...hostConnectors, 'schedule_routine']) {
    assert.equal(exposedSchema(['delegate_task'], name), undefined, name)
  }
})

test('an explicit connector grant is advertised and callable through the descriptor check', () => {
  const enabled = ['delegate_task', 'search_gmail', 'github_comment_draft']
  const registryNames = names(schemasFor(enabled))
  const gatewayNames = names(describeTools(enabled))
  for (const name of ['search_gmail', 'github_comment_draft', 'review_task', 'list_google_accounts']) {
    assert.ok(registryNames.includes(name), name)
    assert.ok(gatewayNames.includes(name), name)
    assert.equal(exposedSchema(enabled, name)?.name, name)
  }
  assert.equal(exposedSchema(enabled, 'read_gmail'), undefined)
})

test('VM-targeted Bots do not expose host connectors, even when explicitly enabled', () => {
  const target = { kind: 'vm', vmId: 'fixture', capabilities: ['computer-v1', 'box-v1'] }
  const enabled = ['delegate_task', 'schedule_routine', ...hostConnectors]
  const registryNames = names(schemasFor(enabled, target))
  const gatewayNames = names(describeTools(enabled, target))
  for (const name of hostConnectors) {
    assert.ok(!registryNames.includes(name), name)
    assert.ok(!gatewayNames.includes(name), name)
    assert.equal(exposedSchema(enabled, name, target), undefined, name)
  }
  assert.ok(registryNames.includes('review_task'))
  assert.ok(gatewayNames.includes('review_task'))
})

test('once scheduling accompanies scheduling; folder observation also requires an existing file-read grant', () => {
  assert.ok(names(schemasFor(['schedule_routine'])).includes('schedule_once'))
  assert.equal(exposedSchema(['schedule_routine'], 'watch_folder'), undefined)
  assert.equal(exposedSchema(['read_file'], 'watch_folder'), undefined)
  assert.equal(exposedSchema(['schedule_routine', 'read_file'], 'watch_folder')?.name, 'watch_folder')
  assert.equal(exposedSchema(['schedule_routine', 'list_dir'], 'watch_folder')?.name, 'watch_folder')
  assert.equal(exposedSchema(['watch_folder'], 'watch_folder')?.name, 'watch_folder')
  const target = { kind: 'vm', vmId: 'fixture', capabilities: ['computer-v1', 'box-v1'] }
  assert.equal(exposedSchema(['schedule_routine', 'read_file', 'watch_folder'], 'watch_folder', target), undefined)
})
