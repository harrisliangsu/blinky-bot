/** Launchd -> open -> mounted Preview, with an isolated fake Codex and data root. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { reconcileRoutineJob } from '../src/main/app/routineLaunchJob.ts'

const bundle=process.env.BLINKY_TEST_APP_BUNDLE
if(!bundle)throw Error('BLINKY_TEST_APP_BUNDLE is required')
const run=promisify(execFile),root=await fs.mkdtemp(path.join(os.tmpdir(),'blinky-launchd-e2e-')),data=path.join(root,'data'),trace=path.join(root,'trace'),fake=path.join(root,'codex'),label='bot.blinky.test.'+randomUUID().replaceAll('-',''),service=`gui/${process.getuid()}/${label}`
await fs.mkdir(path.join(data,'bots'),{recursive:true});await fs.mkdir(path.join(data,'routines'),{recursive:true})
await fs.writeFile(fake,`#!${process.execPath}\n`+String.raw`
const readline=require('node:readline'),fs=require('node:fs');const args=process.argv.slice(2),gateway=args.some(x=>x.startsWith('mcp_servers.openbot='));if(args.includes('--version')){console.log('codex-cli 0.166.0');process.exit()}if(args[0]==='login'){console.log('Logged in using ChatGPT');process.exit()}
const parent=process.ppid;setInterval(()=>{try{process.kill(parent,0)}catch{process.exit()}},100).unref();let n=0;const send=x=>process.stdout.write(JSON.stringify(x)+'\n');function finish(t,text){send({method:'item/started',params:{item:{type:'agentMessage',id:'m-'+t,phase:'final_answer',text:''}}});send({method:'item/agentMessage/delta',params:{itemId:'m-'+t,delta:text}});send({method:'turn/completed',params:{turn:{id:t,status:'completed',items:[]}}})}
readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.method==='initialize')send({id:r.id,result:{}});else if(r.method==='model/list')send({id:r.id,result:{data:[{model:'lead-model',displayName:'Lead'}],nextCursor:null}});else if(r.method==='thread/start'||r.method==='thread/resume')send({id:r.id,result:{approvalsReviewer:r.params.approvalsReviewer??'user',approvalPolicy:r.params.approvalPolicy??'never',sandbox:{type:r.params.sandbox==='workspace-write'?'workspaceWrite':'readOnly',networkAccess:false},thread:{id:'launchd-test'}}});else if(r.method==='turn/start'){const text=r.params.input[0].text,t='t'+(++n);send({id:r.id,result:{turn:{id:t}}});send({method:'turn/started',params:{turn:{id:t},threadId:'launchd-test'}});if(gateway&&text.includes('LAUNCHD_TEST')){fs.appendFileSync(process.env.LAUNCHD_TRACE,'start\n');setTimeout(()=>{fs.appendFileSync(process.env.LAUNCHD_TRACE,'finish\n');finish(t,'launchd response')},3000)}else finish(t,'[]')}})
`);await fs.chmod(fake,0o700)
await fs.writeFile(path.join(data,'settings.json'),JSON.stringify({theme:'light',language:'zh-CN',defaultBackendId:'codex',defaultModelId:'lead-model',defaultMode:'agent',approvalPolicy:'auto-run',runRoutinesWhenClosed:true,backends:{codex:{enabled:true,command:fake,extraArgs:[]}}}))
await fs.writeFile(path.join(data,'bots','blinky.json'),JSON.stringify({id:'blinky',name:'Blinky',systemPrompt:'Test',emoji:'✨',color:'#7c9cff',backendId:'codex',modelId:'lead-model',followsDefault:false,tools:['delegate_task'],computerUse:false,computerTarget:{kind:'local'},createdAt:1,updatedAt:1}))
await fs.writeFile(path.join(data,'routines','scheduled.json'),JSON.stringify({id:'scheduled',botId:'blinky',name:'Launchd fixture',description:'',steps:[],instruction:'LAUNCHD_TEST',trigger:{kind:'schedule',cron:'* * * * *'},replayMode:'adaptive',createdAt:Date.now()-120000}))
const options={label,plistPath:path.join(root,'job.plist'),markerPath:path.join(root,'owner.json'),bundle,enabled:true,uid:process.getuid(),testEnvironment:{BLINKY_SMOKE:'1',BLINKY_SMOKE_DIR:data,OPENBOT_DATA_DIR:data,LAUNCHD_TRACE:trace}}
async function waitFor(f,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(await f())return;await delay(100)}throw Error('timed out waiting for packaged background work')}
try{
 assert.equal((await reconcileRoutineJob(options)).state,'active')
 await run('/bin/launchctl',['kickstart',service])
 await waitFor(async()=>((await fs.readFile(trace,'utf8').catch(()=>'' )).includes('start')))
 assert.equal((await reconcileRoutineJob({...options,enabled:false})).state,'inactive')
 await waitFor(async()=>((await fs.readFile(trace,'utf8').catch(()=>'' )).includes('finish')))
 await waitFor(async()=>{try{return JSON.parse(await fs.readFile(path.join(data,'routines','scheduled.json'),'utf8')).lastRunState==='finished'}catch{return false}})
 await delay(7500)
 const lines=(await fs.readFile(trace,'utf8')).trim().split('\n');assert.deepEqual(lines,['start','finish'])
 const sessions=await fs.readdir(path.join(data,'sessions'));let saved=false;for(const file of sessions)if((await fs.readFile(path.join(data,'sessions',file),'utf8')).includes('launchd response'))saved=true;assert.ok(saved)
 console.log(JSON.stringify({launchdOpenedPackagedApp:true,unregisterDidNotKillWork:true,once:true,sessionSaved:true}))
}finally{
 await run('/bin/launchctl',['bootout',service]).catch(()=>undefined)
 await fs.rm(root,{recursive:true,force:true})
}
