import assert from 'node:assert/strict'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { mainModuleClosure, verifiedLoadedMainModules, mainModulePolicy, mainReceiptSignatures, mainTransportSignatures, verifyRendererDebuggerSources } from './inspect-installed-app.mjs'

const policy = 'const MAX_CONCURRENT_RUNS = 4;\nconst MAX_QUEUED_TASKS_PER_BOT = 1e4;\nconst MAX_QUEUED_TASKS = 5e4;\n'
const functions = 'function getSession(id) {\n  return id;\n}\nfunction saveSession(value) {\n  return value;\n}\nfunction getBot(id) {\n  return id;\n}\nfunction broadcast(event) {\n  sink(EVENT_CHANNEL, event);\n  sendNativeEvent(event);\n}\n'
const app = '/fixture/app.asar'
const closure = entries => mainModuleClosure(app, name => { assert.ok(Object.hasOwn(entries, name), 'Missing module ' + name); return entries[name] })
function inspector(modules, { missing, changed } = {}) {
  let listener, disabled = false
  return { get disabled() { return disabled }, on(fn) { listener = fn; return () => {} }, async send(method, parameters) {
    if (method === 'Debugger.enable') modules.filter(module => module.path !== missing).forEach((module, i) => listener({ method: 'Debugger.scriptParsed', params: { url: pathToFileURL(app + '/' + module.path).href, scriptId: module.path } }))
    if (method === 'Debugger.getScriptSource') return { scriptSource: modules.find(module => module.path === parameters.scriptId).source + (parameters.scriptId === changed ? '\nchanged' : '') }
    if (method === 'Debugger.disable') disabled = true
    return {}
  } }
}
test('single-file old bundle policy and receipt require actual loaded byte match', async () => {
  const modules = closure({ 'out/main/index.js': policy + functions }), client = inspector(modules)
  await verifiedLoadedMainModules(client, app, modules)
  assert.equal(mainModulePolicy(modules).maxConcurrent, 4); assert.ok(mainReceiptSignatures(modules).save.startsWith('function saveSession(')); assert.equal(client.disabled, true)
})
test('chunked bundle follows static imports and re-exports once', async () => {
  const modules = closure({ 'out/main/index.js': 'import { x } from "./chunks/policy.js";\nexport { y } from "./chunks/functions.js";', 'out/main/chunks/policy.js': policy + '\nimport "./functions.js";', 'out/main/chunks/functions.js': functions })
  assert.equal(modules.length, 3)
  await verifiedLoadedMainModules(inspector(modules), app, modules)
  assert.equal(mainModulePolicy(modules).maxQueued, 50000); assert.ok(mainReceiptSignatures(modules).broadcast.includes('EVENT_CHANNEL'))
})
test('missing ASAR dependency and escaped dependency reject', () => {
  assert.throws(() => closure({ 'out/main/index.js': 'import "./missing.js";' }), /Missing module/)
  assert.throws(() => closure({ 'out/main/index.js': 'import "../../outside.js";' }), /inside the ASAR/)
})
test('disk module that was not loaded or has changed memory bytes cannot authorize evidence', async () => {
  const modules = closure({ 'out/main/index.js': 'import "./chunk.js";', 'out/main/chunk.js': policy + functions })
  await assert.rejects(verifiedLoadedMainModules(inspector(modules, { missing: 'out/main/chunk.js' }), app, modules), /actual loaded script/)
  await assert.rejects(verifiedLoadedMainModules(inspector(modules, { changed: 'out/main/chunk.js' }), app, modules), /installed ASAR bytes/)
})
test('ambiguous or missing policy and store signatures reject', () => {
  const modules = closure({ 'out/main/index.js': policy + functions })
  assert.throws(() => mainModulePolicy([...modules, ...modules]), /exactly one/)
  assert.throws(() => mainModulePolicy([...modules, { source: 'let MAX_CONCURRENT_RUNS = 8;' }]), /exactly one declaration/)
  assert.throws(() => mainReceiptSignatures([...modules, ...modules]), /must be unique/)
  assert.throws(() => mainReceiptSignatures(closure({ 'out/main/index.js': policy })), /must be unique/)
  assert.throws(() => mainModulePolicy(closure({ 'out/main/index.js': 'let MAX_CONCURRENT_RUNS = 4;' })), /immutable literal/)
})
test('transport getters accept actual single-line arrows but reject ambiguous or broadened code', () => {
  const body = functions + '\nconst getTask = (id) => collection$2.get(id);\nfunction isRunning(id) {\n return true;\n}\nfunction isQueueSuspended(id) {\n return false;\n}\nfunction isStartCancelled(id) {\n return false;\n}\n'
  const modules = closure({ 'out/main/index.js': body })
  assert.equal(mainTransportSignatures(modules).task, '(id) => collection$2.get(id)')
  assert.throws(() => mainTransportSignatures([...modules, { source: 'const getTask = (id) => other.get(id);' }]), /must be unique/)
  assert.throws(() => mainTransportSignatures(closure({ 'out/main/index.js': body.replace('collection$2.get(id)', 'untrusted(id)') })), /must be unique/)
})
const hash = value => createHash('sha256').update(value).digest('hex')
function rendererDebugger(source, preattached = false) {
  let listener, attached = preattached, detached = 0
  return { isAttached: () => attached, get detached() { return detached }, on(_name, fn) { listener = fn }, removeListener() { listener = undefined }, attach() { attached = true }, detach() { attached = false; detached++ }, async sendCommand(method) {
    if (method === 'Debugger.enable') listener(null, 'Debugger.scriptParsed', { url: 'file:///fixture/renderer.js', scriptId: 'renderer' })
    if (method === 'Debugger.getScriptSource') return { scriptSource: source }
    return {}
  } }
}
test('renderer actual memory bytes must match; only own temporary debugger detaches', async () => {
  const expected = [{ path: '/fixture/renderer.js', sha256: hash('actual loaded module') }], debuggerClient = rendererDebugger('actual loaded module')
  assert.equal((await verifyRendererDebuggerSources(debuggerClient, expected, hash)).temporaryDebuggerDetached, true)
  assert.equal(debuggerClient.detached, 1)
  const changed = rendererDebugger('changed module')
  await assert.rejects(verifyRendererDebuggerSources(changed, expected, hash), /differs from ASAR/)
  assert.equal(changed.detached, 1)
  const occupied = rendererDebugger('actual loaded module', true)
  await assert.rejects(verifyRendererDebuggerSources(occupied, expected, hash), /already attached/)
  assert.equal(occupied.detached, 0); assert.equal(occupied.isAttached(), true)
})
