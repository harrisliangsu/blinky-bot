import assert from'node:assert/strict';import{test}from'node:test';import{mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join,dirname}from'node:path';import{fileURLToPath,pathToFileURL}from'node:url';import{build}from'esbuild';
test('private native consideration advertises no App capabilities; required gateway and normal Agent permissions remain',async()=>{
 const root=await mkdtemp(join(tmpdir(),'blinky-judgment-context-'));globalThis.__judgmentContext={attachments:[],grants:[]}
 try{
  const mocks={
   '../store/bots':'export const getBot=()=>globalThis.__judgmentContext.bot',
   '../agent/executionAgent':'export const bindExecutionAgent=(_id,bot)=>bot',
   './protocol':'export const abortInFlight=()=>{}',
   './server':'export const ensureServer=async()=>{};export const closeServer=async()=>{};export const mcpEndpoint=()=>"http://127.0.0.1/synthetic"',
   './sse':'export const closeStreamsFor=()=>{}',
   './tokens':'export const activeGrantCount=()=>0;export const grantsForSession=()=>[];export const grantCovers=()=>false;export const revokeToken=()=>{};export const setGrantMessage=()=>{};export const mintGrant=input=>{globalThis.__judgmentContext.grants.push(input);return {...input,token:"synthetic-only"}}',
   './turn':'export const runTurn=async args=>({status:"final",message:{content:"synthetic"},mode:"supervised"})',
   './mcpGateway':'export const attachGateway=async input=>{globalThis.__judgmentContext.attachments.push(input);return globalThis.__judgmentContext.actualAttach(input)}',
   './idleClock':'export const startIdleClock=()=>({touch(){},expired(){return false},stop(){}})',
   './cancel':'export const abort=()=>{}', './messages':'export const addNotice=async()=>{}', './events':'export const broadcastError=()=>{}',
   '../backends/chatTiming':'export const traceChatTiming=()=>{}'
  };const outfile=join(root,'test.mjs');await build({stdin:{contents:"export * from './context.ts';export * from './taskJudgmentScope.ts';export * from './supervisedTurn.ts';export * from '../gateway/index.ts';",resolveDir:dirname(fileURLToPath(import.meta.url)),loader:'ts'},platform:'node',bundle:true,format:'esm',outfile,plugins:[{name:'normal-turn-transport',setup(b){b.onResolve({filter:/.*/},a=>Object.hasOwn(mocks,a.path)&&!(a.path==='./tokens'&&!a.importer.includes('/gateway/'))?{path:a.path,namespace:'mock'}:undefined);b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:mocks[a.path],loader:'js'}))}}]});const api=await import(pathToFileURL(outfile).href)
  const bot={id:'bot',name:'Synthetic',backendId:'codex',modelId:'default',systemPrompt:'',tools:['manage_task','delegate_task','decision_review'],computerUse:false,executionAgent:{backendId:'kimi',modelId:'default'}}
  globalThis.__judgmentContext.bot=bot;globalThis.__judgmentContext.actualAttach=api.attachSession;
  const session={id:'source',cwd:root,mode:'agent',messages:[],botIds:[bot.id],todos:[]},schemas=bot.tools.map(name=>({name,description:name,parameters:{type:'object'},mutating:name!=='manage_task'})),settings={language:'zh-CN',decisionSkillReview:true}
  const input={session,bot,settings,memory:[],schemas,roster:[bot],supportsVision:false},normal=api.buildContext(input)
  assert.equal(normal.tools.length,3);assert.match(normal.systemPrompt,/# Decision skill review/);assert.match(normal.systemPrompt,/# Independent execution agent/)
  const turn={session,bot,settings,signal:new AbortController().signal,extras:[],replyTo:null,floor:null,retry:false}
  await api.runSupervisedTurn(turn);assert.equal(globalThis.__judgmentContext.attachments.length,1);assert.equal(globalThis.__judgmentContext.grants.at(-1).tools.length,3)
  const release=api.beginTaskJudgment(session.id,'task',bot.id,'attempt','bounded observations')
  try{
   const privateContext=api.buildContext(input);assert.deepEqual(privateContext.tools,[]);assert.doesNotMatch(privateContext.systemPrompt,/# Decision skill review|# Independent execution agent/)
   await api.runSupervisedTurn(turn);assert.equal(globalThis.__judgmentContext.attachments.length,2);assert.deepEqual(globalThis.__judgmentContext.grants.at(-1).tools,[]);assert.equal(globalThis.__judgmentContext.grants.at(-1).computerUse,false)
   await api.runSupervisedTurn({...turn,session:{...session,id:'real-executor'}});assert.equal(globalThis.__judgmentContext.attachments.length,3);assert.equal(globalThis.__judgmentContext.grants.at(-1).tools.length,3)
  }finally{release()}
  assert.equal(api.buildContext(input).tools.length,3)
 }finally{delete globalThis.__judgmentContext;await rm(root,{recursive:true,force:true})}
})
