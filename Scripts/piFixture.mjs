/** Installed pi against an isolated loopback model provider; no user auth/config. */
import fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'

export async function createPiFixture(root) {
  const configDir=path.join(root,'pi-config'),wrapper=path.join(root,'isolated-pi.cjs'),trace=path.join(root,'pi-argv.jsonl')
  await fs.mkdir(configDir,{recursive:true})
  const requests=[],sockets=new Set()
  let respond=()=>({text:'Fixture response'})
  const server=http.createServer((req,res)=>{
    let raw='';req.on('data',chunk=>raw+=chunk).on('end',async()=>{
      try {
        const body=JSON.parse(raw),row={body,closed:false};requests.push(row);res.on('close',()=>{row.closed=true})
        const answer=await respond(body,row)
        if(answer.hold){res.writeHead(200,{'content-type':'text/event-stream'});res.write(': waiting\n\n');return}
        res.writeHead(200,{'content-type':'text/event-stream'})
        const send=(delta,finish_reason=null)=>res.write('data: '+JSON.stringify({id:'fixture-'+requests.length,object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason}]})+'\n\n')
        send({role:'assistant'})
        if(answer.nativeTool){send({tool_calls:[{index:0,id:'native-fixture',type:'function',function:{name:answer.nativeTool.name,arguments:JSON.stringify(answer.nativeTool.args)}}]});send({},'tool_calls')}
        else {send({content:answer.text??'Fixture response'});send({},'stop')}
        res.end('data: [DONE]\n\n')
      }catch {res.writeHead(500);res.end('{}')}
    })
  })
  server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket))})
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
  const baseUrl=`http://127.0.0.1:${server.address().port}/v1`
  await fs.writeFile(path.join(configDir,'models.json'),JSON.stringify({providers:{fixture:{api:'openai-completions',baseUrl,apiKey:'local-fixture-only',compat:{supportsDeveloperRole:false},models:['lead-model','worker-model'].map(id=>({id,name:id,reasoning:true,input:['text'],contextWindow:32000,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}))}}}))
  await fs.writeFile(path.join(configDir,'settings.json'),JSON.stringify({defaultProvider:'fixture',defaultModel:'lead-model',defaultThinkingLevel:'low',quietStartup:true,enableSkillCommands:false}))
  // Local authentication presence for app discovery. The provider itself uses
  // only the dummy key in models.json and never reads the user's login store.
  await fs.writeFile(path.join(configDir,'auth.json'),'{}\n')
  await fs.writeFile(wrapper,`#!/usr/bin/env node
const fs=require('node:fs'),{spawn}=require('node:child_process');
const args=process.argv.slice(2),take=flag=>{const i=args.lastIndexOf(flag);return i<0?undefined:args[i+1]};
fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({model:take('--model'),thinking:take('--thinking'),noTools:args.includes('--no-tools'),noExtensions:args.includes('--no-extensions'),mode:take('--mode')})+'\\n');
const child=spawn('/opt/homebrew/bin/pi',[...args,'--no-skills','--no-prompt-templates','--no-context-files','--offline'],{stdio:'inherit',env:{...process.env,PI_CODING_AGENT_DIR:${JSON.stringify(configDir)},PI_OFFLINE:'1',PI_TELEMETRY:'0'}});
child.on('error',()=>process.exit(1));child.on('exit',(code,signal)=>{if(signal)process.kill(process.pid,signal);else process.exit(code??1)});
`)
  await fs.chmod(wrapper,0o700)
  return {root,configDir,wrapper,trace,requests,baseUrl,setResponse(fn){respond=fn},async close(){for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve))}}
}
