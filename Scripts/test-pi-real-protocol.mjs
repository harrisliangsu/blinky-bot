import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {build} from 'esbuild'
import {createPiFixture} from './piFixture.mjs'
const root=await fs.mkdtemp(path.join(os.tmpdir(),'blinky-pi-protocol-'))
process.env.OPENBOT_DATA_DIR=root
const fixture=await createPiFixture(root)
const bundle=await build({entryPoints:['src/main/backends/cli/pi.ts'],bundle:true,write:false,platform:'node',format:'esm'})
const {piBackend}=await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const schema={name:'delegate_task',description:'A virtual test action',parameters:{type:'object',properties:{prompt:{type:'string'}}}}
async function collect(request,extraArgs=[]){const chunks=[];for await(const chunk of piBackend.chat({model:'fixture/lead-model',cwd:root,messages:[{role:'user',content:'Synthetic protocol probe'}],tools:[schema],disableNativeTools:true,signal:new AbortController().signal,...request},{enabled:true,command:fixture.wrapper,extraArgs}))chunks.push(chunk);return chunks}
const result={realPi:true,realModel:false,localProvider:true}
try {
 fixture.setResponse(()=>({text:'Direct local response'}))
 let chunks=await collect({thinking:'high'})
 assert.equal(chunks.filter(c=>c.type==='text').map(c=>c.delta).join(''),'Direct local response')
 assert.equal(fixture.requests.at(-1).body.model,'lead-model');assert.equal(fixture.requests.at(-1).body.reasoning_effort,'high')
 assert.equal(fixture.requests.at(-1).body.tools?.length??0,0);result.directAndModel=true
 await collect({thinking:'high'},['--model','fixture/worker-model','--thinking','low','--mode','rpc'])
 assert.equal(fixture.requests.at(-1).body.model,'lead-model');assert.equal(fixture.requests.at(-1).body.reasoning_effort,'high');result.selectedRuntimeWinsExtraArgs=true
 await assert.rejects(collect({thinking:'ultra'}),/does not support the selected thinking depth/);result.unsupportedThinkingFailsClearly=true
 fixture.setResponse(()=>({text:'<openbot_tool_call>{"name":"delegate_task","arguments":{"prompt":"Synthetic work"}}</openbot_tool_call>'}))
 chunks=await collect({});assert.equal(chunks.filter(c=>c.type==='tool_call').length,1);assert.deepEqual(chunks.find(c=>c.type==='tool_call').call.args,{prompt:'Synthetic work'});assert.equal(chunks.filter(c=>c.type==='text').map(c=>c.delta).join(''),'');result.promptedDispatch=true
 fixture.setResponse(()=>({text:'Default model respected'}))
 await collect({model:'default'});const argv=(await fs.readFile(fixture.trace,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(argv.at(-1).model,undefined);assert.equal(fixture.requests.at(-1).body.model,'lead-model');result.nativeDefault=true
 const nativeFile=path.join(root,'must-not-exist.txt')
 fixture.setResponse(body=>body.messages.some(m=>m.role==='tool')?{text:'Native tool was refused'}:{nativeTool:{name:'write',args:{path:nativeFile,content:'unexpected'}}})
 chunks=await collect({});assert.equal(await fs.stat(nativeFile).then(()=>true,()=>false),false);assert.ok(chunks.some(c=>c.type==='text'&&c.delta.includes('refused')));result.nativeToolDisabled=true
 const count=fixture.requests.length
 for(const extra of [['--tools','bash'],['-t','write'],['--extension','/fixture.js'],['-e','/fixture.js']])await assert.rejects(collect({},extra),/cannot enable native tools or extensions/)
 assert.equal(fixture.requests.length,count);result.extraArgsCannotBypass=true
 fixture.setResponse(()=>({hold:true}))
 const controller=new AbortController(),pending=collect({signal:controller.signal})
 const start=Date.now();while(fixture.requests.length===count&&Date.now()-start<20000)await new Promise(r=>setTimeout(r,20))
 assert.ok(fixture.requests.length>count);const row=fixture.requests.at(-1),stoppedAt=Date.now();controller.abort()
 await Promise.race([pending,new Promise((_,reject)=>setTimeout(()=>reject(Error('pi did not stop')),6000).unref())])
 for(let i=0;i<100&&!row.closed;i++)await new Promise(r=>setTimeout(r,20));assert.equal(row.closed,true);result.stopMs=Date.now()-stoppedAt
 assert.ok(argv.every(row=>row.mode!=='json'||(row.noTools&&row.noExtensions)))
 await fs.mkdir('docs/test-evidence/pi-delegation-20261106',{recursive:true});await fs.writeFile('docs/test-evidence/pi-delegation-20261106/real-protocol.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result))
}finally{await fixture.close();await fs.rm(root,{recursive:true,force:true})}
