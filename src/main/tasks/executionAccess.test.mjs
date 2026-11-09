import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture } from './controlFixture.mjs'

test('a full-access executor still asks the owning Bot for grounded facts and reversible choices using tool-free inference', async () => {
 const f=await fixture()
 try {
  f.api.updateBot(f.bot.id,{executionAgent:{backendId:'codex',modelId:'worker',accessMode:'full-access'}})
  const task=await f.start();assert.equal(task.executionAgent.accessMode,'full-access')
  const home=f.api.getSession(f.home.id)
  f.api.saveSession({...home,messages:[...home.messages,{id:'fact',role:'user',content:'Use reports/weekly for the synthetic output.',createdAt:Date.now()}]})
  f.state.answer={text:JSON.stringify({answers:{directory:{kind:'fact',sourceKind:'user',sessionId:f.home.id,messageId:'fact',answer:'reports/weekly',quote:'Use reports/weekly for the synthetic output.'}}}),calls:[],reasoning:''}
  const result=await f.api.requestTaskClarification(task.sessionId,f.bot.id,[{id:'directory',header:'Directory',kind:'fact',question:'Which output directory?'}],new AbortController().signal)
  assert.deepEqual(JSON.parse(JSON.stringify(result)),{directory:['reports/weekly']})
  f.state.answer={text:JSON.stringify({answers:{format:{kind:'decision',answer:'Markdown',reason:'Ordinary reversible synthetic report format',routineReversible:true,requiresUserAuthorization:false}}}),calls:[],reasoning:''}
  const decision=await f.api.requestTaskClarification(task.sessionId,f.bot.id,[{id:'format',header:'Format',kind:'implementation',question:'Choose a reversible report format.'}],new AbortController().signal)
  assert.deepEqual(JSON.parse(JSON.stringify(decision)),{format:['Markdown']})
  for (const call of f.state.sideCalls) {assert.equal(call[1].readOnly,true);assert.equal(call[1].disableNativeTools,true);assert.equal(call[1].executionAccess,undefined)}
  assert.equal(f.state.events.some(e=>e.type==='task-clarification-updated'&&e.request.status==='waiting_user'),false)
 } finally {await f.close()}
})
