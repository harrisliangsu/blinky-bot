/** Canonical-path launch diagnostic for the frozen avatar acceptance build. */
import fs from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {setTimeout as delay} from 'node:timers/promises'
const evidence=path.resolve('docs/test-evidence/avatar-20261106')
const result=JSON.parse(await fs.readFile(path.join(evidence,'result.json'),'utf8'))
const snapshot=JSON.parse(await fs.readFile(path.join(evidence,'snapshot.json'),'utf8')).sourceSnapshot
const executable=await fs.realpath(path.join(snapshot,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'))
const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p))})})
const data=path.join(result.root,'data');let log='',ws
const app=spawn(executable,['.',`--remote-debugging-port=${port}`,'--remote-allow-origins=*'],{cwd:snapshot,env:{...process.env,BLINKY_SMOKE:'1',BLINKY_SMOKE_DIR:data,OPENBOT_DATA_DIR:data},stdio:['ignore','pipe','pipe']})
app.stdout.on('data',x=>log+=x);app.stderr.on('data',x=>log+=x)
try{
 let target
 for(let i=0;i<250;i++){try{target=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.type==='page');if(target)break}catch{}await delay(100)}
 assert.ok(target,'No renderer');ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j})
 let seq=0;const pending=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){pending.get(m.id)(m.result);pending.delete(m.id)}}
 const cmd=(method,params={})=>new Promise(r=>{const id=++seq;pending.set(id,r);ws.send(JSON.stringify({id,method,params}))})
 let state
 for(let i=0;i<250;i++) {const r=await cmd('Runtime.evaluate',{expression:`({ready:!!document.querySelector('#ob-prompt'),avatar:document.querySelector('.ob-header-bot-trigger .ob-avatar')?.dataset.avatarShape})`,returnByValue:true});state=r.result?.value;if(state?.ready)break;await delay(100)}
 assert.equal(state?.ready,true);assert.equal(state?.avatar,'legacy')
 assert.equal(log.includes('sandbox_extension_issue_file_to_process'),false)
 await fs.writeFile(path.join(evidence,'canonical-launch.json'),JSON.stringify({passed:true,executable,snapshot,data,state,noSandboxExtensionWarning:true},null,2))
 console.log('Canonical executable launch passed; application ready; no sandbox-extension path warning')
}finally{ws?.close();app.kill('SIGTERM');await Promise.race([new Promise(r=>app.once('close',r)),delay(2500)]);if(app.exitCode===null)app.kill('SIGKILL');await fs.writeFile(path.join(evidence,'canonical-electron.log'),log)}
