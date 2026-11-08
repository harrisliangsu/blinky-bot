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

test('approved workspace control saves an optional routing choice through the existing settings handler', async () => {
  globalThis.__routingRpc = []
  assert.deepEqual(await call(access, { quickDecision: choice }), { value: { quickDecision: choice } })
  assert.deepEqual(globalThis.__routingRpc, [{ channel: 'openbot:settings:update', args: [{ quickDecision: choice }] }])
  assert.deepEqual(await call(access, { quickDecision: null }), { value: { quickDecision: null } })
})

test('routing never bypasses view-only, room-only, revoked or sensitive-settings restrictions', async () => {
  globalThis.__routingRpc = []
  await assert.rejects(call({ ...access, permission: 'view' }, { quickDecision: choice }), { status: 403 })
  await assert.rejects(call({ ...access, scope: 'room' }, { quickDecision: choice }), { status: 403 })
  let reads = 0
  await assert.rejects(call(access, { quickDecision: choice }, () => ++reads === 1), { status: 401 })
  for (const field of ['backends', 'localExecutionPolicy', 'automaticReview', 'allowlist']) {
    await assert.rejects(call(access, { quickDecision: choice, [field]: {} }), { status: 403 })
  }
  assert.deepEqual(globalThis.__routingRpc, [])
})
