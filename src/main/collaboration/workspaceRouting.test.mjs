import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { resolve, dirname } from 'node:path'

// Run the actual RPC policy and dispatch. Only unrelated business adapters are
// replaced; no browser, credentials or user data are involved.
const file = resolve('src/main/collaboration/workspaceRpc.ts')
const source = await readFile(file, 'utf8')
const imports = new Map()
for (const [, names, module] of source.matchAll(/import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+'([^']+)'/g)) {
  imports.set(module, [...new Set([...(imports.get(module) ?? []), ...names.split(',').map(name => name.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0])])])
}
const result = await build({ entryPoints: [file], bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{ name: 'routing-rpc-adapters', setup(b) {
  b.onResolve({ filter: /.*/ }, a => imports.has(a.path) && a.path !== '../../shared/remoteCapabilities' ? { path: a.path, namespace: 'fixture' } : undefined)
  b.onLoad({ filter: /.*/, namespace: 'fixture' }, a => ({ contents: imports.get(a.path).map(name => {
    if (name === 'RoomAccessError') return 'export class RoomAccessError extends Error { constructor(status,message){super(message);this.status=status} }'
    if (name === 'publicRemoteData') return 'export const publicRemoteData=value=>value'
    if (name === 'invokeRemoteBusinessHandler') return 'export const invokeRemoteBusinessHandler=async(channel,args)=>{globalThis.__routingRpc.push({channel,args});return args[0]}'
    return `export const ${name}=()=>{throw Error('Unrelated adapter called: ${name}')}`
  }).join('\n') }))
} }] })
const { remoteRpc } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].contents).toString('base64'))
const choice = { backendId: 'synthetic-routing-provider', modelId: 'synthetic-routing-model' }
const access = { scope: 'workspace', permission: 'control' }
const call = (who, patch, allowed = () => true) => remoteRpc(who, {}, { channel: 'openbot:settings:update', args: [patch] }, allowed)

test('approved workspace control still saves ordinary model preferences through the existing handler', async () => {
  globalThis.__routingRpc = []
  const patch = { defaultBackendId: choice.backendId, defaultModelId: choice.modelId }
  assert.deepEqual(await call(access, patch), { value: patch })
  assert.deepEqual(globalThis.__routingRpc, [{ channel: 'openbot:settings:update', args: [patch] }])
})

test('retired routing cannot be re-enabled remotely, and ordinary preferences keep their access restrictions', async () => {
  globalThis.__routingRpc = []
  for (const value of [choice, null]) await assert.rejects(call(access, { quickDecision: value }), { status: 403 })
  await assert.rejects(call({ ...access, permission: 'view' }, { defaultModelId: choice.modelId }), { status: 403 })
  await assert.rejects(call({ ...access, scope: 'room' }, { defaultModelId: choice.modelId }), { status: 403 })
  let reads = 0
  await assert.rejects(call(access, { defaultModelId: choice.modelId }, () => ++reads === 1), { status: 401 })
  for (const field of ['backends', 'localExecutionPolicy', 'automaticReview', 'allowlist']) {
    await assert.rejects(call(access, { defaultModelId: choice.modelId, [field]: {} }), { status: 403 })
  }
  assert.deepEqual(globalThis.__routingRpc, [])
})
