import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'

// Real turn/context/stream/call dispatch with a scripted model and in-memory
// persistence. No CLI, Electron, credentials, user data or network is used.
const mocks = {
  './quickDecision': 'export const quickDecisionHint=async()=>null',
  '../tasks/clarifications': 'export const requestTaskClarification=async()=>null',
  './backendGateway': `export const detectBackends=async()=>[{id:globalThis.__route.bot.backendId,kind:globalThis.__route.bot.backendId==='pi'?'agent-cli':'api-key',status:'available',label:'Fixture'}]; export const getBackend=async()=>({}); export const getModelInfo=async()=>({contextWindow:32000}); export const backendConfigFor=()=>({}); export const normaliseCall=x=>x; export async function openChatStream(_backend,request){globalThis.__route.request=request; return (async function*(){for(const chunk of globalThis.__route.chunks)yield chunk})()}`,
  './messages': `export const assistantMessage=b=>({id:'answer',role:'assistant',content:'',botId:b.id,model:b.modelId,createdAt:1}); export const begin=()=>{}; export const addNotice=async()=>{}; export const commit=async(_s,m)=>{globalThis.__route.message=m}; export const addToolMessage=async(_s,_b,r)=>{globalThis.__route.results.push(r)}`,
  './sessionGateway': `export const sessions={update:async(s,fn)=>{fn(s);return true}}; export const bots={many:async()=>[globalThis.__route.bot]}`,
  '../store/bots': 'export const applyBotBinding=b=>b',
  '../store/sessions': 'export const hydrateRecentImages=s=>s',
  '../store/tasks': 'export const listTasks=()=>[]',
  '../store/jsonStore': 'export const flushAll=async()=>({failed:[],stillWriting:false})',
  '../store/mcpSecrets': 'export const mcpBearerToken=()=>undefined',
  './events': 'export const broadcast=()=>{}; export const broadcastError=()=>{}; export const onAgentEvent=()=>()=>{}',
  './skillsGateway': 'export const skillsSection=async()=>""',
  './memoryGateway': 'export const memoryStore={list:async()=>[]}',
  './mcpGateway': 'export const noteGatewayMessage=async()=>{}',
  './approval': 'export const requestApproval=async()=>({approved:true})',
  './recorder': 'export const captureToolStep=()=>{};export const noteFrame=()=>{}',
  './builtinHandlers': 'export const applyTodos=()=>{};export const normaliseTodos=()=>[];export const runRemember=()=>({ok:true});export const runTodoWrite=()=>({ok:true})',
  './handoff': 'export const sessionRoster=async()=>[globalThis.__route.bot];export const handoffTo=async()=>({ok:false});export const takePendingNote=()=>undefined;export const performHandoff=async()=>({ok:false})',
  './toolGateway': `export const schemasFor=async ids=>ids.includes('delegate_task')?[globalThis.__route.delegate.schema]:[]; export const getTool=async name=>name==='delegate_task'?globalThis.__route.delegate:null`,
  './toolContext': `export const SELF_APPROVING=new Set(); export const buildToolContext=({session,bot,call,signal})=>({sessionId:session.id,botId:bot.id,callId:call.id,signal,host:{listBots:async()=>[bot],delegateTask:async(...args)=>{globalThis.__route.dispatched.push(args);return {id:'task',sessionId:'private',sourceSessionId:session.id,title:args[4],botId:bot.id}}}})`,
  '../vm/appleVmSupervisor': 'export const startAppleVm=async()=>{}',
  '../store/vmSecrets': 'export const vmToken=()=>undefined'
}
const bundle = await build({
  stdin: { contents: `export {runTurn} from './turn.ts'; export {modeFor} from './backendMode.ts'; export {supportsExecutionDelegation} from '../../shared/executionAgentCapabilities.ts'; export {buildChatRequest} from './chatRequest.ts'; export {bindExecutionAgent,setExecutionAgent,clearExecutionAgent} from './executionAgent.ts'; export {delegateTaskTool} from '../tools/agent/delegate.ts'`, resolveDir: new URL('.', import.meta.url).pathname, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 'model-and-app-boundaries', setup(b) {
    b.onResolve({ filter: /.*/ }, a => Object.hasOwn(mocks, a.path) ? { path: a.path, namespace: 'fixture' } : undefined)
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, a => ({ contents: mocks[a.path], loader: 'js' }))
  } }]
})
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
function fixture(mode = 'agent') {
  const bot = { id: 'lead', name: 'Lead', backendId: 'openai', modelId: 'lead-model', thinking: 'low', followsDefault: false, executionAgent: { backendId: 'kimi', modelId: 'worker-model', thinking: 'high' }, tools: ['delegate_task'], computerUse: false, computerTarget: { kind: 'local' } }
  globalThis.__route = { bot, delegate: api.delegateTaskTool, chunks: [], dispatched: [], results: [] }
  return { bot, session: { id: 'source', mode, botIds: [bot.id], activeBotId: bot.id, cwd: '/isolated', messages: [{ id: 'request', role: 'user', content: 'Synthetic request', createdAt: 1 }] }, settings: { approvalPolicy: 'auto-run', language: 'en', backends: {} }, signal: new AbortController().signal }
}

test('a simple model reply finishes on the lead without creating any execution task', async () => {
  const input = fixture()
  globalThis.__route.chunks = [{ type: 'text', delta: 'Simple answer' }, { type: 'done' }]
  const result = await api.runTurn(input)
  assert.equal(result.status, 'final')
  assert.equal(result.message.content, 'Simple answer')
  assert.deepEqual(globalThis.__route.dispatched, [])
  assert.equal(globalThis.__route.request.model, 'lead-model')
  assert.equal(globalThis.__route.request.thinking, 'low')
  assert.match(globalThis.__route.request.messages[0].content, /Answer simple questions.*directly/)
  assert.match(globalThis.__route.request.messages[0].content, /Delegate multi-step work/)
})

test('a model-selected complex task reaches the real delegation handler exactly once', async () => {
  const input = fixture()
  globalThis.__route.chunks = [{ type: 'tool_call', call: { id: 'dispatch', name: 'delegate_task', args: { prompt: 'Inspect, implement and validate the synthetic change', title: 'Complex work' } } }, { type: 'done' }]
  const result = await api.runTurn(input)
  assert.equal(result.status, 'tools')
  assert.equal(globalThis.__route.results[0].ok, true)
  assert.equal(globalThis.__route.dispatched.length, 1)
  assert.deepEqual(globalThis.__route.dispatched[0].slice(0, 5), ['source', 'lead', 'lead', 'Inspect, implement and validate the synthetic change', 'Complex work'])
})

test('Agent binding sends its own model/depth and keeps the lead configuration intact', () => {
  const input = fixture()
  const before = structuredClone(input.bot)
  api.setExecutionAgent('private', input.bot.executionAgent)
  try {
    const bot = api.bindExecutionAgent('private', input.bot)
    const request = api.buildChatRequest({ ...input, bot, session: { ...input.session, id: 'private' }, mode: 'orchestrated', messages: [], tools: [] })
    assert.equal(bot.backendId, 'kimi')
    assert.equal(request.model, 'worker-model')
    assert.equal(request.thinking, 'high')
    assert.equal(request.captureAgentTrace, true)
    assert.equal(bot.tools.includes('delegate_task'), false)
    assert.deepEqual(input.bot, before)
  } finally { api.clearExecutionAgent('private') }
})

test('Ask mode still hides delegation and directly answers without dispatch', async () => {
  const input = fixture('ask')
  globalThis.__route.chunks = [{ type: 'text', delta: 'Read-only answer' }, { type: 'done' }]
  const result = await api.runTurn(input)
  assert.equal(result.status, 'final')
  assert.deepEqual(globalThis.__route.dispatched, [])
  assert.equal(globalThis.__route.request.tools?.some(t => t.name === 'delegate_task') ?? false, false)
  assert.doesNotMatch(globalThis.__route.request.messages[0].content, /# Independent execution agent/)
})


test('pi ordinary host chat uses the application loop and leaves simple replies on the lead', async () => {
  const input = fixture()
  input.bot.backendId = 'pi'
  globalThis.__route.chunks = [{ type: 'text', delta: 'Direct pi reply' }, { type: 'done' }]
  const result = await api.runTurn(input)
  assert.equal(result.status, 'final')
  assert.equal(result.mode, 'orchestrated')
  assert.equal(result.message.content, 'Direct pi reply')
  assert.deepEqual(globalThis.__route.dispatched, [])
  assert.equal(globalThis.__route.request.disableNativeTools, true)
  assert.equal(globalThis.__route.request.model, 'lead-model')
  assert.equal(globalThis.__route.request.thinking, 'low')
  assert.ok(globalThis.__route.request.tools.some(t => t.name === 'delegate_task'))
})

test('pi model-selected delegation reaches the existing tool handler once', async () => {
  const input = fixture()
  input.bot.backendId = 'pi'
  input.bot.executionAgent = { backendId: 'pi', modelId: 'worker-model', thinking: 'high' }
  globalThis.__route.chunks = [{ type: 'tool_call', call: { id: 'pi-call', name: 'delegate_task', args: { prompt: 'Synthetic work' } } }, { type: 'done' }]
  const result = await api.runTurn(input)
  assert.equal(result.status, 'tools')
  assert.equal(result.mode, 'orchestrated')
  assert.equal(globalThis.__route.dispatched.length, 1)
  assert.equal(globalThis.__route.results[0].ok, true)
})

test('pi Ask and Plan do not advertise delegation or native tools', async () => {
  for (const mode of ['ask', 'plan']) {
    const input = fixture(mode)
    input.bot.backendId = 'pi'
    globalThis.__route.chunks = [{ type: 'text', delta: 'Read-only pi reply' }, { type: 'done' }]
    await api.runTurn(input)
    assert.equal(globalThis.__route.request.disableNativeTools, true)
    assert.equal(globalThis.__route.request.tools?.some(t => t.name === 'delegate_task') ?? false, false)
    assert.deepEqual(globalThis.__route.dispatched, [])
  }
})

test('pi keeps application approvals and selected runtime while withholding direct MCP execution', async () => {
  const input = fixture()
  input.bot.backendId = 'pi'
  input.settings.mcpServers = [{ id: 'external', name: 'External', enabled: true, transport: 'stdio', command: 'external' }]
  const tools = [globalThis.__route.delegate.schema]
  const request = api.buildChatRequest({ ...input, mode: 'orchestrated', messages: [], tools })
  assert.equal(request.tools, tools)
  assert.equal(request.model, 'lead-model')
  assert.equal(request.thinking, 'low')
  assert.deepEqual(request.mcpServers, [])
  assert.equal(request.approvalPolicy, 'auto-run')
  assert.equal(api.modeFor({ id: 'pi', kind: 'agent-cli' }, { kind: 'local' }), 'orchestrated')
  assert.equal(api.modeFor({ id: 'pi', kind: 'agent-cli' }, { kind: 'vm' }), 'orchestrated')
  assert.equal(api.modeFor({ id: 'grok', kind: 'agent-cli' }), 'supervised')
  assert.equal(api.modeFor({ id: 'droid', kind: 'agent-cli' }), 'supervised')
  assert.equal(api.supportsExecutionDelegation('pi'), true)
  assert.equal(api.supportsExecutionDelegation('droid'), false)
})
