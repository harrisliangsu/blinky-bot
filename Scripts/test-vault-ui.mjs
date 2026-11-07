/** Isolated Electron regression using disposable fixture values and real safeStorage. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const repo=process.cwd(),root=await fs.mkdtemp(path.join(os.tmpdir(),'blinky-vault-ui-')),data=path.join(root,'data')
let received
const fixture=http.createServer((req,res)=>{const u=new URL(req.url,'http://localhost');if(u.pathname==='/result'){received=u.searchParams.get('value');res.end('ok');return}res.setHeader('content-type','text/html');res.end('<input id="input" type="password" autocomplete="current-password" style="position:absolute;left:20px;top:20px;width:180px;height:30px"><button id="button" style="position:absolute;left:20px;top:70px;width:100px;height:30px">Test</button><script>button.onclick=()=>fetch("/result?value="+encodeURIComponent(input.value))</script>')})
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve))
const site=`http://127.0.0.1:${fixture.address().port}`
await fs.mkdir(data);await fs.writeFile(path.join(data,'settings.json'),JSON.stringify({theme:'light',language:'zh-CN'}))
const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})})
const electron=path.join(repo,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');let logs=''
function launch(){const child=spawn(electron,['.',`--remote-debugging-port=${port}`,'--remote-allow-origins=*'],{cwd:repo,env:{...process.env,BLINKY_SMOKE:'1',BLINKY_SMOKE_DIR:data,OPENBOT_DATA_DIR:data},stdio:['ignore','pipe','pipe']});child.stdout.on('data',x=>logs+=x);child.stderr.on('data',x=>logs+=x);return child}
let app=launch(),ws,seq=0;const pending=new Map()
function cmd(method,params={}){const id=++seq;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}))})}
async function evalJs(expression){const value=await cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(value.exceptionDetails)throw Error(JSON.stringify(value.exceptionDetails));return value.result.value}
async function connect(){let targets;const end=Date.now()+30000;while(Date.now()<end){try{targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();if(targets.some(t=>t.type==='page'))break}catch{}await delay(100)}if(!targets?.some(t=>t.type==='page'))throw Error('No renderer');ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject});ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)}}}
async function wait(expression,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(await evalJs(expression))return;await delay(100)}throw Error('Timed out waiting for vault state; logs: '+logs.slice(-1200))}
async function stop(){if(ws)ws.close();app.kill('SIGTERM');for(let i=0;i<50&&app.exitCode===null&&app.signalCode===null;i++)await delay(100);if(app.exitCode===null&&app.signalCode===null)app.kill('SIGKILL')}
async function openVault(){await wait(`!!document.querySelector('#ob-prompt')`);await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:true,bubbles:true,cancelable:true}))`);await wait(`!!document.querySelector('.ob-palette-item')`);await evalJs(`[...document.querySelectorAll('.ob-palette-item')].find(x=>x.textContent.trim()==='Settings').click()`);await wait(`!!document.querySelector('#ob-set-tab-vault')`);await evalJs(`document.querySelector('#ob-set-tab-vault').click()`);await wait(`!!document.querySelector('.ob-vault')`)}
async function fill(label,value){await evalJs(`(()=>{const label=[...document.querySelectorAll('.ob-vault-form label')].find(x=>x.textContent.trim()===${JSON.stringify(label)});const e=label.querySelector('input');e.focus();e.select()})()`);await cmd('Input.insertText',{text:value})}
const secret='fixture-vault-secret-7319'
try {
 await connect();await openVault();await evalJs(`[...document.querySelectorAll('.ob-vault-intro button')].find(x=>x.textContent.trim()==='添加').click()`)
 await wait(`!!document.querySelector('.ob-vault-form')`)
 await fill('名称','Fixture login');await fill('网站（填入浏览器时必填）',site+'/path');await fill('用户名','fixture-user');await fill('密码',secret)
 await evalJs(`document.querySelector('.ob-vault-form button[type="submit"]').click()`)
 await wait(`document.querySelector('.ob-vault-items')?.innerText.includes('Fixture login')`)
 const list=await evalJs(`window.openbot.vault.list()`);assert.equal(list.ok,true);assert.equal(list.value.length,1);assert.equal(list.value[0].origin,site);assert.ok(!JSON.stringify(list).includes(secret))
 const raw=await fs.readFile(path.join(data,'vault.json'),'utf8');assert.ok(!raw.includes(secret));assert.ok(!logs.includes(secret))
 const bot=await evalJs(`window.openbot.bots.list().then(bs=>bs[0])`);assert.ok(bot.activeConversationId)
 const updated=await evalJs(`window.openbot.bots.update(${JSON.stringify(bot.id)},{computerTarget:{kind:'browser',botId:${JSON.stringify(bot.id)},provider:'chrome'}})`);assert.equal(updated.ok,true)
 const navigate=await evalJs(`window.openbot.bots.controlScreen(${JSON.stringify(bot.id)},{type:'navigate',url:${JSON.stringify(site)}})`);assert.equal(navigate.ok,true)
 const click=await evalJs(`window.openbot.bots.controlScreen(${JSON.stringify(bot.id)},{type:'click',x:50,y:35})`);assert.equal(click.ok,true)
 const rejected=await evalJs(`window.openbot.vault.fill(${JSON.stringify(bot.id)},'wrong-session',${JSON.stringify(list.value[0].id)},'password')`);assert.equal(rejected.ok,false)
 const filled=await evalJs(`window.openbot.vault.fill(${JSON.stringify(bot.id)},${JSON.stringify(bot.activeConversationId)},${JSON.stringify(list.value[0].id)},'password')`);assert.deepEqual(filled,{ok:true,value:true});assert.ok(!JSON.stringify(filled).includes(secret))
 assert.equal(received,undefined,'fill must not submit')
 const submit=await evalJs(`window.openbot.bots.controlScreen(${JSON.stringify(bot.id)},{type:'click',x:50,y:85})`);assert.equal(submit.ok,true)
 for(let i=0;i<40&&received===undefined;i++)await delay(100);assert.equal(received,secret)
 await stop();await delay(300);app=launch();await connect();await openVault();await wait(`document.querySelector('.ob-vault-items')?.innerText.includes('Fixture login')`)
 assert.ok(!JSON.stringify(await evalJs(`window.openbot.vault.list()`)).includes(secret))
 await evalJs(`document.querySelector('.ob-vault-item button').click()`);await wait(`document.querySelector('.ob-vault-actions')?.innerText.includes('确认删除')`);await evalJs(`document.querySelector('.ob-vault-actions button').click()`)
 await wait(`window.openbot.vault.list().then(r=>r.ok&&r.value.length===0)`)
 const after=await fs.readFile(path.join(data,'vault.json'),'utf8');assert.ok(!after.includes(secret))
 console.log(JSON.stringify({realSafeStorage:true,metadataOnly:true,encryptedOnDisk:true,manualBrowserFill:true,noAutomaticSubmit:true,restartReadback:true,confirmedRemoval:true}))
} finally {await stop();fixture.closeAllConnections();fixture.close();await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:200})}
