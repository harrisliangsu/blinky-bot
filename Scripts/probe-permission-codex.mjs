/** Credential-free native protocol probe. Never submits a turn or tool. */
import {spawn} from 'node:child_process'
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createInterface} from 'node:readline'
import {connectionTestEnvironment} from '../src/main/connectors/testEnvironment.mjs'
const root=await mkdtemp(join(tmpdir(),'blinky-codex-policy-probe-')),env=await connectionTestEnvironment(root)
await mkdir(env.CODEX_HOME,{recursive:true})
const binary=process.env.BLINKY_CODEX_PROBE_BINARY
if(!binary)throw new Error('Set BLINKY_CODEX_PROBE_BINARY to the installed Codex executable. The probe never loads real credentials.')
const child=spawn(binary,['app-server'],{cwd:root,env,stdio:['pipe','pipe','pipe']})
let err='',settled=false
child.stderr.on('data',x=>err+=x)
let timer
const result=await new Promise((resolve,reject)=>{
 timer=setTimeout(()=>reject(Error('isolated app-server handshake timeout')),15000)
 child.on('error',reject)
 child.on('exit',code=>{if(!settled)reject(Error('app-server exited '+code+' '+err.slice(-500)))})
 createInterface({input:child.stdout}).on('line',line=>{
  let m;try{m=JSON.parse(line)}catch{return}
  if(m.id===1){
   if(m.error){settled=true;reject(Error(JSON.stringify(m.error)));return}
   child.stdin.write(JSON.stringify({method:'initialized'})+'\n')
   child.stdin.write(JSON.stringify({id:2,method:'thread/start',params:{cwd:root,approvalPolicy:'untrusted',sandbox:'read-only',approvalsReviewer:'user',experimentalRawEvents:false,persistExtendedHistory:false}})+'\n')
  }
  if(m.id===2){
   settled=true
   if(m.error)reject(Error(JSON.stringify(m.error)))
   else resolve({initialized:true,threadStarted:!!m.result?.thread?.id,approvalPolicy:m.result?.approvalPolicy,sandbox:m.result?.sandbox,approvalsReviewer:m.result?.approvalsReviewer,noTurnOrToolStarted:true,isolatedRoot:root})
  }
 })
 child.stdin.write(JSON.stringify({id:1,method:'initialize',params:{clientInfo:{name:'blinky-permission-probe',version:'1.0.0'},capabilities:{experimentalApi:true}}})+'\n')
}).finally(()=>{clearTimeout(timer);child.kill('SIGTERM')})
if(process.env.BLINKY_CODEX_PROBE_OUTPUT)await writeFile(process.env.BLINKY_CODEX_PROBE_OUTPUT,JSON.stringify(result,null,2))
console.log(JSON.stringify(result))
