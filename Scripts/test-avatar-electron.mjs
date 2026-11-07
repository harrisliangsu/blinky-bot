/** Isolated real Electron acceptance. All accounts/models are synthetic fixtures. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { createHash } from 'node:crypto'
const repo=process.cwd(), root=await fs.mkdtemp(path.join(os.tmpdir(),'blinky-avatar-'))
const data=path.join(root,'data'), evidence=path.resolve(process.env.BLINKY_AVATAR_EVIDENCE||'docs/test-evidence/avatar-20261106')
await fs.mkdir(path.join(data,'bots'),{recursive:true});await fs.mkdir(path.join(evidence,'tiles'),{recursive:true})
for(const name of ['result.json','failure.json','failure.png']){
  await fs.rename(path.join(evidence,name),path.join(evidence,'diagnostic-previous-'+name)).catch(error=>{if(error.code!=='ENOENT')throw error})
}
const bundleHashes={}
for(const file of ['out/main/index.js','out/preload/index.cjs',...((await fs.readdir('out/renderer/assets')).filter(x=>/^index-.*\.(js|css)$/.test(x)).map(x=>'out/renderer/assets/'+x)),'src/renderer/src/assets/avatars/layers.json'])bundleHashes[file]=createHash('sha256').update(await fs.readFile(file)).digest('hex')
const fake=path.join(root,'fake-codex.cjs')
await fs.writeFile(fake,String.raw`#!/usr/bin/env node
const rl=require('node:readline'),a=process.argv.slice(2),send=x=>process.stdout.write(JSON.stringify(x)+'\n');let n=0,thread='avatar-fixture';
if(a.includes('--version')){console.log('codex-cli 0.166.0');process.exit(0)}if(a[0]==='login'){console.log('Logged in using ChatGPT');process.exit(0)}
rl.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);
if(r.method==='initialize')send({id:r.id,result:{}});
else if(r.method==='model/list')send({id:r.id,result:{data:[{model:'avatar-fixture',displayName:'Avatar fixture',isDefault:true}],nextCursor:null}});
else if(r.method==='thread/start'||r.method==='thread/resume'){thread=r.params.threadId||'avatar-'+process.pid;send({id:r.id,result:{approvalsReviewer:r.params.approvalsReviewer??'user',approvalPolicy:r.params.approvalPolicy??'never',sandbox:{type:r.params.sandbox==='workspace-write'?'workspaceWrite':'readOnly',networkAccess:false},thread:{id:thread}}})}
else if(r.method==='turn/start'){const turn='turn-'+(++n),text=r.params.input.map(x=>x.text||'').join('\n'),hold=text.includes('__AVATAR_REPLY__');send({id:r.id,result:{turn:{id:turn}}});send({method:'turn/started',params:{threadId:thread,turn:{id:turn}}});send({method:'item/started',params:{item:{id:turn,type:'agentMessage',phase:'final_answer',text:''}}});send({method:'item/agentMessage/delta',params:{itemId:turn,delta:hold?'Avatar fixture replying':'Fixture title'}});setTimeout(()=>send({method:'turn/completed',params:{turn:{id:turn,status:'completed',items:[]}}}),hold?6000:20)}
else if(r.method==='turn/interrupt'){send({id:r.id,result:{}})}
});
`);await fs.chmod(fake,0o700)
const backends=Object.fromEntries(['claude','grok','opencode','kimi','pi','droid','openai','anthropic','openrouter','xai','ollama','lmstudio'].map(id=>[id,{enabled:false}]))
backends.codex={enabled:true,command:fake,extraArgs:[]}
await fs.writeFile(path.join(data,'settings.json'),JSON.stringify({theme:'dark',language:'zh-CN',vibrant:false,defaultBackendId:'codex',defaultModelId:'avatar-fixture',memoryExtraction:'off',backends}))
const old={id:'legacy-avatar',name:'Legacy Turtle',description:'',systemPrompt:'Synthetic fixture',emoji:'🐢',color:'#AA9999',backendId:'codex',modelId:'avatar-fixture',followsDefault:false,tools:[],computerUse:false,computerTarget:{kind:'local'},createdAt:1,updatedAt:1}
await fs.writeFile(path.join(data,'bots','legacy-avatar.json'),JSON.stringify(old))
await fs.writeFile(path.join(data,'bots','unknown-avatar.json'),JSON.stringify({...old,id:'unknown-avatar',name:'Unknown avatar',avatarShape:'future-shape',avatarColor:'future-color',createdAt:2}))
const port=await new Promise((resolve,reject)=>{const server=net.createServer();server.on('error',reject);server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p))})})
// macOS sandbox-extension resolution rejects the temporary node_modules alias.
const electron=await fs.realpath(process.env.BLINKY_AVATAR_EXECUTABLE||path.join(repo,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'))
const args=process.env.BLINKY_AVATAR_EXECUTABLE?[]:['.']
let app,ws,seq=0,logs='',errors=[];const pending=new Map()
function launch(){app=spawn(electron,[...args,`--remote-debugging-port=${port}`,'--remote-allow-origins=*'],{cwd:repo,env:{...process.env,BLINKY_SMOKE:'1',BLINKY_SMOKE_DIR:data,OPENBOT_DATA_DIR:data},stdio:['ignore','pipe','pipe']});app.stdout.on('data',x=>logs+=x);app.stderr.on('data',x=>logs+=x)}
function cmd(method,params={}){const id=++seq;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))})}
async function evaluate(expression){const r=await cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value}
async function wait(expression,timeout=25000){const end=Date.now()+timeout;while(Date.now()<end){if(await evaluate(expression))return;await delay(50)}throw Error('Timeout '+expression+'\n'+await evaluate('document.body.innerText.slice(-1600)'))}
async function connect(){const end=Date.now()+30000;let t;while(Date.now()<end){try{const a=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();t=a.find(x=>x.type==='page');if(t)break}catch{}await delay(100)}if(!t)throw Error('Electron target missing '+logs.slice(-1800));ws=new WebSocket(t.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const x=pending.get(m.id);pending.delete(m.id);m.error?x.reject(Error(JSON.stringify(m.error))):x.resolve(m.result)}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params)};await cmd('Runtime.enable')}
async function click(selector){await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)}
async function setInput(selector,value){await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`)}
async function screenshot(name,selector){await delay(100);const clip=selector?await evaluate(`(()=>{const b=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height,scale:1}})()`):undefined;const r=await cmd('Page.captureScreenshot',{format:'png',...(clip?{clip}:{}),captureBeyondViewport:true});await fs.writeFile(path.join(evidence,name),Buffer.from(r.data,'base64'))}
async function stop(){ws?.close();app?.kill('SIGTERM');if(app)await Promise.race([new Promise(r=>app.once('close',r)),delay(2500)]);if(app?.exitCode===null)app.kill('SIGKILL')}
const shapes=['round','square','heart','wide-oval','drop','triangle','hexagon','diamond','cloud','flower','star','bean','pentagon'],colors=['cream','lavender','lilac','sky','mint','sage','butter','apricot','peach','rose','mist'];const saved=[]
const result={realElectron:true,realModel:false,startedAt:new Date().toISOString(),bundleHashes,root,executable:electron,created:[],screenshots:[]}
try{
 launch();await connect();await wait(`!!document.querySelector('#ob-prompt')`)
 assert.equal(await evaluate(`document.querySelector('.ob-header-bot-trigger .ob-avatar').getAttribute('data-avatar-shape')`),'legacy')
 assert.match(await evaluate(`document.querySelector('.ob-header-bot-trigger .ob-avatar').textContent`),/🐢/)
 let bots=await evaluate('window.openbot.bots.list()');assert.equal(bots.find(b=>b.id==='unknown-avatar').avatarShape,'round');assert.equal(bots.find(b=>b.id==='unknown-avatar').avatarColor,'cream');result.legacyAndUnknownFallback=true
 await click('.ob-header-bot-trigger');await wait(`!!document.querySelector('#ob-bot-details')`);await click('#ob-bot-details .ob-bot-editor-disclosure > summary');await click('#ob-bot-details .ob-bot-editor-save .ob-btn-primary')
 assert.equal(await evaluate(`document.querySelectorAll('#ob-bot-details .ob-avatar-picker [role=radio][aria-checked=true]').length`),0)
 await wait(`window.openbot.bots.get('legacy-avatar').then(b=>b.emoji==='🐢'&&!b.avatarShape)`);await click('[aria-label="关闭 Bot 详情"]');result.legacyEditPreserved=true
 await click('[aria-label="Create a bot"]');await wait(`!!document.querySelector('#ob-create-bot-name')`)
 assert.equal(await evaluate(`document.querySelectorAll('.ob-avatar-shapes [role=radio]').length`),13)
 assert.equal(await evaluate(`document.querySelectorAll('.ob-avatar-colors [role=radio]').length`),11)
 // Actual keyboard events through Chromium, not an onClick substitute.
 await evaluate(`document.querySelector('.ob-avatar-choice[data-shape="round"]').focus()`)
 await cmd('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight'});await cmd('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight'})
 await wait(`document.querySelector('.ob-avatar-choice[data-shape="square"]').getAttribute('aria-checked')==='true'`)
 await cmd('Input.dispatchKeyEvent',{type:'keyDown',key:'End',code:'End'});await cmd('Input.dispatchKeyEvent',{type:'keyUp',key:'End',code:'End'})
 await wait(`document.querySelector('.ob-avatar-choice[data-shape="pentagon"]').getAttribute('aria-checked')==='true'`)
 await screenshot('create-dark.png');result.screenshots.push('create-dark.png');result.keyboardSelection=true
 // Capture every real UI combination; no gallery reimplementation.
 for(const color of colors){await click(`.ob-avatar-color[data-color="${color}"]`);for(const shape of shapes){await click(`.ob-avatar-choice[data-shape="${shape}"]`);await screenshot(`tiles/${shape}-${color}-dark.png`,'.ob-create-bot-preview')}}
 result.colorCombinations=143
 await cmd('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape'});await cmd('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape'});await wait(`!document.querySelector('#ob-create-bot-name')`);result.escapeClose=true
 for(const [i,shape] of shapes.entries()){
   await click('[aria-label="Create a bot"]');await wait(`!!document.querySelector('#ob-create-bot-name')`)
   await setInput('#ob-create-bot-name','Avatar '+shape);await click(`.ob-avatar-choice[data-shape="${shape}"]`);await click(`.ob-avatar-color[data-color="${colors[i%colors.length]}"]`)
   await click('.ob-create-bot-actions button[type="submit"]');await wait(`document.querySelector('.ob-header-bot-trigger')?.textContent.includes(${JSON.stringify('Avatar '+shape)})`)
   const b=(await evaluate('window.openbot.bots.list()')).find(b=>b.name==='Avatar '+shape);assert.equal(b.avatarShape,shape);assert.equal(b.avatarColor,colors[i%colors.length]);saved.push(b);result.created.push({id:b.id,shape,color:b.avatarColor})
 }
 await click('.ob-header-bot-trigger');await wait(`!!document.querySelector('#ob-bot-details')`);await click('#ob-bot-details .ob-bot-editor-disclosure > summary')
 assert.equal(await evaluate(`document.querySelector('#ob-bot-details .ob-avatar-choice[aria-checked=true]').dataset.shape`),'pentagon')
 await click('#ob-bot-details .ob-avatar-choice[data-shape="heart"]');await click('#ob-bot-details .ob-avatar-color[data-color="mint"]');await setInput('#ob-bot-name','Avatar edited');await click('#ob-bot-details .ob-bot-editor-save .ob-btn-primary')
 await wait(`window.openbot.bots.list().then(b=>b.some(x=>x.id===${JSON.stringify(saved.at(-1).id)}&&x.avatarShape==='heart'&&x.avatarColor==='mint'&&x.name==='Avatar edited'))`)
 await screenshot('details-dark.png');result.editSave=true
 const identities=await evaluate(`Array.from(document.querySelectorAll('.ob-header-bot-trigger .ob-avatar,#ob-bot-details > .ob-bot-details-body > .ob-bot-details-identity .ob-avatar,.ob-side-item-main[aria-label="Avatar edited"] .ob-avatar')).map(e=>[e.dataset.avatarShape,e.dataset.avatarColor])`)
 assert.equal(identities.length,3);for(const identity of identities)assert.deepEqual(identity,['heart','mint']);result.identityConsistency=true
 await click('[aria-label="关闭 Bot 详情"]')
 // A real missing-file image error must render the default, without mutating identity.
 await evaluate(`document.querySelector('.ob-header-bot-trigger svg defs > g > image').setAttribute('href','file:///nonexistent-blinky-avatar-fixture.png')`)
 await wait(`document.querySelector('.ob-header-bot-trigger .ob-avatar').dataset.avatarShape==='round'`)
 await click('.ob-side-item-main[aria-label="Legacy Turtle"]');await wait(`document.querySelector('.ob-header-bot-trigger')?.textContent.includes('Legacy Turtle')`)
 await click('.ob-side-item-main[aria-label="Avatar edited"]');await wait(`document.querySelector('.ob-header-bot-trigger .ob-avatar')?.dataset.avatarShape==='heart'`);result.missingResourceFallback=true
 await setInput('#ob-prompt','__AVATAR_REPLY__');await evaluate(`document.querySelector('#ob-prompt').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true}))`)
 await wait(`!!document.querySelector('.ob-header-bot-trigger .ob-avatar.is-replying')`)
 await delay(450)
 const running=await evaluate(`(()=>{const a=document.querySelector('.ob-header-bot-trigger .ob-avatar');return {avatar:getComputedStyle(a).transform,eye:getComputedStyle(a.querySelector('.ob-avatar-gaze')).transform,viewBox:a.querySelector('svg').getAttribute('viewBox')}})()`)
 assert.equal(running.avatar,'none');assert.notEqual(running.eye,'none');await screenshot('replying-dark.png');result.replying=running
 await click('.ob-side-item-main[aria-label="Legacy Turtle"]');await wait(`document.querySelector('.ob-header-bot-trigger')?.textContent.includes('Legacy Turtle')&&!document.querySelector('.ob-header-bot-trigger .ob-avatar.is-replying')`)
 assert.ok(await evaluate(`!!document.querySelector('.ob-side-item-main[aria-label="Avatar edited"] .ob-avatar.is-replying')`));result.backgroundReplyScopedToItsBot=true
 await click('.ob-side-item-main[aria-label="Avatar edited"]');await wait(`!!document.querySelector('.ob-header-bot-trigger .ob-avatar.is-replying')`)
 await wait(`!document.querySelector('.ob-header-bot-trigger .ob-avatar.is-replying')`,15000);await delay(450)
 assert.equal(await evaluate(`getComputedStyle(document.querySelector('.ob-header-bot-trigger .ob-avatar-gaze')).transform`),'none');result.replyRecenters=true
 // Observe natural, independent blinking instead of forcing the class.
 await wait(`!!document.querySelector('.ob-header-bot-trigger .ob-avatar.is-blinking')`,12000)
 await screenshot('natural-blink.png');result.naturalBlink=true
 await cmd('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await wait(`document.querySelector('.ob-header-bot-trigger .ob-avatar').dataset.avatarMotion==='static'`)
 assert.ok(parseFloat(await evaluate(`getComputedStyle(document.querySelector('.ob-header-bot-trigger .ob-avatar-eyelid')).transitionDuration`))<.001);result.reducedMotion=true
 await setInput('#ob-prompt','__AVATAR_REPLY__');await evaluate(`document.querySelector('#ob-prompt').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true}))`)
 await wait(`window.openbot.bots.list().then(async b=>await window.openbot.agent.isRunning(b.find(x=>x.name==='Avatar edited').activeConversationId))`)
 await delay(450);assert.equal(await evaluate(`getComputedStyle(document.querySelector('.ob-header-bot-trigger .ob-avatar-gaze')).transform`),'none');assert.equal(await evaluate(`!!document.querySelector('.ob-header-bot-trigger .ob-avatar.is-blinking')`),false)
 await wait(`window.openbot.bots.list().then(async b=>!await window.openbot.agent.isRunning(b.find(x=>x.name==='Avatar edited').activeConversationId))`);result.reducedMotionDuringReply=true
 await cmd('Emulation.setEmulatedMedia',{features:[]})
 await evaluate(`window.openbot.settings.update({theme:'light'})`);await wait(`document.documentElement.dataset.theme==='light'`)
 await click('[aria-label="Create a bot"]');await wait(`!!document.querySelector('#ob-create-bot-name')`);await click('.ob-avatar-choice[data-shape="heart"]');await click('.ob-avatar-color[data-color="mint"]');await screenshot('create-light.png');result.screenshots.push('create-light.png')
 for(const color of colors){await click(`.ob-avatar-color[data-color="${color}"]`);for(const shape of shapes){await click(`.ob-avatar-choice[data-shape="${shape}"]`);await screenshot(`tiles/${shape}-${color}-light.png`,'.ob-create-bot-preview')}}
 await cmd('Emulation.setDeviceMetricsOverride',{width:600,height:640,deviceScaleFactor:1,mobile:false});await screenshot('create-narrow.png');const layout=await evaluate(`(()=>{const p=document.querySelector('.ob-modal'),f=document.querySelector('.ob-create-bot');return {viewport:innerWidth,panel:p.getBoundingClientRect().toJSON(),scroll:f.scrollWidth,width:f.clientWidth}})()`);assert.ok(layout.panel.right<=601&&layout.scroll<=layout.width+1);result.narrowLayout=layout
 await cmd('Emulation.clearDeviceMetricsOverride');await stop()
 launch();await connect();await wait(`!!document.querySelector('#ob-prompt')`)
 bots=await evaluate('window.openbot.bots.list()');for(const b of saved){const read=bots.find(x=>x.id===b.id);assert.equal(read.avatarShape,b.id===saved.at(-1).id?'heart':b.avatarShape);assert.equal(read.avatarColor,b.id===saved.at(-1).id?'mint':b.avatarColor)}
 assert.equal(bots.find(x=>x.id==='legacy-avatar').emoji,'🐢');assert.equal(bots.find(x=>x.id==='legacy-avatar').avatarShape,undefined);result.restartRestore=true
 result.rendererErrors=errors;assert.equal(errors.length,0);result.passed=true
 await fs.writeFile(path.join(evidence,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result))
}catch(error){await screenshot('failure.png').catch(()=>{});await fs.writeFile(path.join(evidence,'failure.json'),JSON.stringify({error:String(error),stack:error.stack,root,logs:logs.slice(-6000),errors},null,2));throw error}
finally{await stop();await fs.writeFile(path.join(evidence,'electron.log'),logs)}
