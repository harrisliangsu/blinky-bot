/** Isolated headless Electron runner: no LaunchAgent or real user data. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const repo=process.cwd(),root=await fs.mkdtemp(path.join(os.tmpdir(),'blinky-runner-')),data=path.join(root,'data'),trace=path.join(root,'trace'),fake=path.join(root,'codex')
await fs.mkdir(path.join(data,'bots'),{recursive:true});await fs.mkdir(path.join(data,'routines'),{recursive:true})
await fs.writeFile(fake,`#!${process.execPath}\n`+String.raw`
const readline=require('node:readline'),fs=require('node:fs');const args=process.argv.slice(2),hasGateway=args.some(x=>x.startsWith('mcp_servers.openbot='));if(args.includes('--version')){console.log('codex-cli 0.166.0');process.exit()}if(args[0]==='login'){console.log('Logged in using ChatGPT');process.exit()}
const parent=process.ppid;setInterval(()=>{try{process.kill(parent,0)}catch{process.exit()}},100).unref();let n=0;const send=x=>process.stdout.write(JSON.stringify(x)+'\n');function finish(turn,text){send({method:'item/started',params:{item:{type:'agentMessage',id:'m-'+turn,phase:'final_answer',text:''}}});send({method:'item/agentMessage/delta',params:{itemId:'m-'+turn,delta:text}});send({method:'turn/completed',params:{turn:{id:turn,status:'completed',items:[]}}})}
readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.method==='initialize')send({id:r.id,result:{}});else if(r.method==='model/list')send({id:r.id,result:{data:[{model:'lead-model',displayName:'Lead'}],nextCursor:null}});else if(r.method==='thread/start'||r.method==='thread/resume')send({id:r.id,result:{approvalsReviewer:r.params.approvalsReviewer??'user',approvalPolicy:r.params.approvalPolicy??'never',sandbox:{type:r.params.sandbox==='workspace-write'?'workspaceWrite':'readOnly',networkAccess:false},thread:{id:'runner-test'}}});else if(r.method==='turn/start'){const text=r.params.input[0].text,turn='t'+(++n);send({id:r.id,result:{turn:{id:turn}}});send({method:'turn/started',params:{turn:{id:turn},threadId:'runner-test'}});if(hasGateway&&text.includes('RUNNER_TEST')){fs.appendFileSync(process.env.RUNNER_TRACE,'triggered\n');setTimeout(()=>finish(turn,'runner response'),1200)}else finish(turn,'[]')}})
`);await fs.chmod(fake,0o700)
const settings={theme:'light',language:'zh-CN',defaultBackendId:'codex',defaultModelId:'lead-model',defaultMode:'agent',approvalPolicy:'auto-run',runRoutinesWhenClosed:true,backends:{codex:{enabled:true,command:fake,extraArgs:[]}}}
await fs.writeFile(path.join(data,'settings.json'),JSON.stringify(settings))
await fs.writeFile(path.join(data,'bots','blinky.json'),JSON.stringify({id:'blinky',name:'Blinky',systemPrompt:'Test',emoji:'✨',color:'#7c9cff',backendId:'codex',modelId:'lead-model',followsDefault:false,tools:['delegate_task'],computerUse:false,computerTarget:{kind:'local'},createdAt:1,updatedAt:1}))
await fs.writeFile(path.join(data,'routines','scheduled.json'),JSON.stringify({id:'scheduled',botId:'blinky',name:'Runner fixture',description:'',steps:[],instruction:'RUNNER_TEST',trigger:{kind:'schedule',cron:'* * * * *'},replayMode:'adaptive',createdAt:Date.now()-120000}))
const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})}),packaged=process.env.BLINKY_TEST_APP_EXECUTABLE,electron=packaged||path.join(repo,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');let logs=''
function launch(args=[],dataPath=data,tracePath=trace){const p=spawn(electron,[...(packaged?[]:['.']),...args,`--remote-debugging-port=${port}`,'--remote-allow-origins=*'],{cwd:repo,env:{...process.env,BLINKY_SMOKE:'1',BLINKY_SMOKE_DIR:dataPath,OPENBOT_DATA_DIR:dataPath,RUNNER_TRACE:tracePath},stdio:['ignore','pipe','pipe']});p.stdout.on('data',x=>logs+=x);p.stderr.on('data',x=>logs+=x);return p}
async function waitFile(file,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(await fs.stat(file).then(()=>true,()=>false))return;await delay(100)}throw Error('timeout '+file+' logs '+logs.slice(-1800))}
async function exited(child,ms=20000){const end=Date.now()+ms;while(Date.now()<end){if(child.exitCode!==null||child.signalCode!==null)return;await delay(100)}throw Error('runner did not exit: '+logs.slice(-1800))}
let child
try{
 child=launch(['--routine-runner']);await waitFile(path.join(data,'ready'));await waitFile(trace)
 let targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();assert.equal(targets.filter(t=>t.type==='page').length,0,'runner must not create a window')
 const duplicate=launch(['--routine-runner']);await exited(duplicate);await delay(300)
 assert.equal((await fs.readFile(trace,'utf8')).trim().split('\n').length,1,'duplicate wake must not repeat the task')
 await exited(child);const routine=JSON.parse(await fs.readFile(path.join(data,'routines','scheduled.json'),'utf8'));assert.equal(routine.lastRunState,'finished')
 const files=await fs.readdir(path.join(data,'sessions'));let found=false;for(const f of files)if((await fs.readFile(path.join(data,'sessions',f),'utf8')).includes('runner response'))found=true;assert.ok(found,'result must be durable before runner exits')
 await fs.writeFile(path.join(data,'settings.json'),JSON.stringify({...settings,runRoutinesWhenClosed:false}));await fs.writeFile(path.join(data,'routines','scheduled.json'),JSON.stringify({...routine,lastRunAt:Date.now()-120000}))
 child=launch(['--routine-runner']);await exited(child);assert.equal((await fs.readFile(trace,'utf8')).trim().split('\n').length,1,'disabled runner must not execute work')
 await fs.writeFile(path.join(data,'settings.json'),JSON.stringify(settings));await fs.writeFile(path.join(data,'routines','scheduled.json'),JSON.stringify({...routine,lastRunAt:Date.now()}))
 child=launch(['--routine-runner']);for(let i=0;i<200;i++){try{await fetch(`http://127.0.0.1:${port}/json/version`);break}catch{}await delay(100)}
 const foreground=launch([]);await exited(foreground)
 let opened=false;for(let i=0;i<200;i++){try{targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();if(targets.some(t=>t.type==='page')){opened=true;break}}catch{}await delay(100)}assert.ok(opened,'opening the app must show a window on the running worker')
 await delay(6500);assert.equal(child.exitCode,null,'the promoted interactive app must stay open')
 child.kill('SIGTERM');await exited(child)
 const damaged=path.join(root,'damaged-data'),damagedTrace=path.join(root,'damaged-trace')
 for(const dir of ['bots','routines','sessions'])await fs.mkdir(path.join(damaged,dir),{recursive:true})
 await fs.writeFile(path.join(damaged,'settings.json'),JSON.stringify(settings))
 await fs.writeFile(path.join(damaged,'bots','blinky.json'),JSON.stringify({id:'blinky',name:'Blinky',systemPrompt:'Test',emoji:'✨',color:'#7c9cff',backendId:'codex',modelId:'lead-model',followsDefault:false,tools:['delegate_task'],computerUse:false,computerTarget:{kind:'local'},activeConversationId:'unreadable',createdAt:1,updatedAt:1}))
 await fs.writeFile(path.join(damaged,'sessions','unreadable.json'),'{ invalid json')
 await fs.writeFile(path.join(damaged,'routines','scheduled.json'),JSON.stringify({...routine,lastRunAt:Date.now()-120000}))
 child=launch(['--routine-runner'],damaged,damagedTrace);await exited(child)
 const preserved=JSON.parse(await fs.readFile(path.join(damaged,'bots','blinky.json'),'utf8'));assert.equal(preserved.activeConversationId,'unreadable')
 assert.equal(await fs.readFile(damagedTrace,'utf8').catch(()=>''),'','unreadable chat must not run in a replacement conversation')
 assert.equal(JSON.parse(await fs.readFile(path.join(damaged,'routines','scheduled.json'),'utf8')).lastRunState,'failed')
 console.log(JSON.stringify({headless:true,scheduledOnce:true,duplicateWakeSilent:true,resultDurable:true,idleExit:true,disabledNoExecution:true,interactivePromotion:true,unreadableChatNotRebound:true}))
}finally{if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await fs.rm(root,{recursive:true,force:true})}
