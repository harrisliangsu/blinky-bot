// Reopen only this integration task's synthetic data with the final mounted app.
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import net from 'node:net'
import {setTimeout as delay} from 'node:timers/promises'
import {connectionTestEnvironment} from '../src/main/connectors/testEnvironment.mjs'
import {connectPreview} from './fixtures/preview-debugger.mjs'
const root=process.env.BLINKY_INTEGRATION_RESTART_ROOT, executable=process.env.BLINKY_PLANNING_EXECUTABLE
assert.ok(root&&executable?.includes('/BlinkyBot Preview.app/'))
const data=path.join(root,'data'),out=path.join(root,'evidence','restart')
await fs.mkdir(out,{recursive:true})
const records=async()=>Promise.all((await fs.readdir(path.join(data,'tasks'))).filter(n=>n.endsWith('.json')).map(async n=>JSON.parse(await fs.readFile(path.join(data,'tasks',n),'utf8'))))
const before=await records();assert.ok(before.length>0&&before.every(t=>['completed','cancelled','failed'].includes(t.status)))
const freePort=()=>new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p))})})
const uiPort=await freePort(),mainPort=await freePort(),env=await connectionTestEnvironment(root)
Object.assign(env,{OPENBOT_DATA_DIR:data,BLINKY_SMOKE:'1',BLINKY_SMOKE_DIR:data})
const child=spawn(executable,['--remote-debugging-address=127.0.0.1','--remote-debugging-port='+uiPort,'--inspect=127.0.0.1:'+mainPort,'--user-data-dir='+path.join(root,'chromium')],{cwd:process.cwd(),env,stdio:['ignore','pipe','pipe']})
let logs='',ui,main,result={realElectron:true,realModel:false,syntheticData:true,checks:[]}
child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b)
try{
 ui=await connectPreview(child,uiPort,'page',()=>logs);main=await connectPreview(child,mainPort,undefined,()=>logs)
 for(let i=0;i<200&&!await ui.evaluate('Boolean(window.openbot)');i++)await delay(100)
 result.runtime=await main.evaluate(`(()=>{globalThis.__restartElectron=process.getBuiltinModule('module').createRequire(process.execPath)('electron');return {appPath:__restartElectron.app.getAppPath(),userData:__restartElectron.app.getPath('userData'),electron:process.versions.electron,pid:process.pid}})()`)
 assert.equal(result.runtime.userData,data)
 const after=await ui.evaluate('window.openbot.tasks.list()')
 assert.equal(after.length,before.length)
 for(const old of before){const next=after.find(t=>t.id===old.id);assert.equal(next.status,old.status);assert.equal(next.workspace?.path,old.workspace?.path);assert.equal(next.sessionId,old.sessionId)}
 assert.ok(after.every(t=>!['queued','running'].includes(t.status)))
 const home=await ui.evaluate(`window.openbot.sessions.get('planning-home')`)
 assert.equal(home.messages.filter(m=>m.id.startsWith('agent-judgment-old-')).length,205)
 assert.ok(home.messages.some(m=>m.id==='integration-visible-goal'))
 result.checks=['same-final-mounted-app-restarted','task-status-session-and-workspace-retained','no-executor-task-replayed','205-private-history-and-public-goal-retained'];result.ok=true
}catch(e){result.ok=false;result.error=e.stack;process.exitCode=1}
finally{
 if(main)await main.evaluate('__restartElectron.app.quit()').catch(()=>{})
 ui?.close();main?.close()
 if(child.exitCode===null&&child.signalCode===null)await Promise.race([new Promise(r=>child.once('exit',r)),delay(8000)])
 if(child.exitCode===null&&child.signalCode===null){result.forcedTermination=true;child.kill('SIGTERM');await delay(300)}
 result.exitCode=child.exitCode;result.signal=child.signalCode
 await fs.writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));await fs.writeFile(path.join(out,'electron.log'),logs)
 console.log(JSON.stringify(result))
}
