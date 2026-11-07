import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const repo=process.cwd(),root=await mkdtemp(join(tmpdir(),'blinky-vault-tool-'))
const built=await build({stdin:{resolveDir:repo,contents:`export {typeTextTool} from './src/main/tools/computer/keyboardTools';export * as vault from './src/main/store/vault'`},bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent',plugins:[{name:'isolated-provider',setup(b){
  b.onResolve({filter:/^\.\/index$/},({importer})=>importer.endsWith('/computer/gate.ts')?{path:'provider',namespace:'fixture'}:undefined)
  b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export const LOCAL_TARGET={kind:'local'};export const describeTarget=()=> 'virtual browser';export const getComputerProvider=()=>globalThis.__vaultToolProvider`,loader:'js'}))
}}]})
after(async()=>{await rm(root,{recursive:true,force:true})})
async function fixture(run){
  const path=join(root,Math.random()+'.mjs');await writeFile(path,built.outputFiles[0].text)
  const previous=process.env.OPENBOT_DATA_DIR;process.env.OPENBOT_DATA_DIR=root
  const api=await import(pathToFileURL(path).href),key=randomBytes(32),secret='virtual-only-field-4826';let decrypts=0,fills=0,screens=0,typed=''
  // Virtual AES-GCM avoids claiming OS encryption in the Node fixture.
  api.vault.setVaultStorageForTests({isEncryptionAvailable:()=>true,encryptString:value=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),bytes=Buffer.concat([c.update(value,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),bytes])},decryptString:value=>{decrypts++;const c=createDecipheriv('aes-256-gcm',key,value.subarray(0,12));c.setAuthTag(value.subarray(12,28));return Buffer.concat([c.update(value.subarray(28)),c.final()]).toString('utf8')}})
  await rm(join(root,'vault.json'),{force:true})
  const item=await api.vault.addVaultItem({kind:'login',label:'Virtual',origin:'https://fixture.invalid',values:{password:secret}})
  const approvals=[],emitted=[],controller=new AbortController(),state={app:'fixture.invalid',throwOnFill:false}
  globalThis.__vaultToolProvider={activeApp:async()=>state.app,fillVaultField:async(origin,field,value)=>{fills++;assert.equal(value,secret);assert.equal(origin,'https://fixture.invalid');if(state.throwOnFill)throw Error(secret);return field==='password'},screenshot:async()=>{screens++;return {image:'virtual-png',width:100,height:100,scale:1}},typeText:async text=>{typed=text}}
  const ctx={sessionId:'virtual-session',botId:'virtual-bot',cwd:root,dataDir:root,computerTarget:{kind:'browser',botId:'virtual-bot',provider:'ego'},signal:controller.signal,settings:{computerUseAllowedApps:['fixture.invalid']},emit:e=>emitted.push(e),requestApproval:async req=>{approvals.push(req);return true}}
  try{await run({api,secret,item,ref:api.vault.vaultItemRef(item.id),ctx,state,controller,approvals,emitted,counters:()=>({decrypts,fills,screens,typed})})}
  finally{api.vault.setVaultStorageForTests(undefined);delete globalThis.__vaultToolProvider;if(previous===undefined)delete process.env.OPENBOT_DATA_DIR;else process.env.OPENBOT_DATA_DIR=previous}
}
test('the registered type_text handler fills by reference only after approval, without frames or returned values',async()=>fixture(async({api,ctx,ref,approvals,emitted,counters,secret})=>{
  ctx.requestApproval=async req=>{approvals.push(req);assert.equal(counters().decrypts,0);return true}
  const args={text:ref,vault_field:'password'},result=await api.typeTextTool.handler(args,ctx)
  assert.equal(result.ok,true);assert.equal(result.screenshot,undefined);assert.equal(counters().fills,1);assert.equal(counters().screens,0);assert.equal(counters().typed,'');assert.deepEqual(emitted,[]);assert.equal(approvals[0].force,true)
  assert.ok(!JSON.stringify({result,approvals,args}).includes(secret));assert.equal(args.text,ref)
}))
test('denial, allowlist changes and cancellation refuse before decrypting',async()=>fixture(async({api,ctx,ref,state,controller,counters})=>{
  ctx.requestApproval=async()=>false;assert.equal((await api.typeTextTool.handler({text:ref,vault_field:'password'},ctx)).ok,false)
  ctx.requestApproval=async()=>{state.app='other.invalid';return true};assert.equal((await api.typeTextTool.handler({text:ref,vault_field:'password'},ctx)).ok,false)
  state.app='fixture.invalid';ctx.requestApproval=async()=>{controller.abort();return true};assert.equal((await api.typeTextTool.handler({text:ref,vault_field:'password'},ctx)).ok,false)
  assert.equal(counters().decrypts,0);assert.equal(counters().fills,0)
}))
test('invalid references, fields and local targets cannot become plain typing or a secret retrieval path',async()=>fixture(async({api,ctx,ref,counters})=>{
  for(const args of [{text:ref},{text:'vault://ref/bad',vault_field:'password'},{text:ref,vault_field:'unknown'},{text:'plaintext',vault_field:'password'}])assert.equal((await api.typeTextTool.handler(args,ctx)).ok,false)
  ctx.computerTarget={kind:'local'};assert.equal((await api.typeTextTool.handler({text:ref,vault_field:'password'},ctx)).ok,false);assert.equal(counters().decrypts,0);assert.equal(counters().typed,'')
}))
test('provider errors and unavailable encryption never return a decrypted value',async()=>fixture(async({api,ctx,ref,state,secret})=>{
  state.throwOnFill=true;const failed=await api.typeTextTool.handler({text:ref,vault_field:'password'},ctx);assert.equal(failed.ok,false);assert.ok(!JSON.stringify(failed).includes(secret))
  api.vault.setVaultStorageForTests(null);const unavailable=await api.typeTextTool.handler({text:ref,vault_field:'password'},ctx);assert.equal(unavailable.ok,false);assert.ok(!JSON.stringify(unavailable).includes(secret))
}))
test('ordinary type_text keeps its text and existing computer frame path',async()=>fixture(async({api,ctx,counters})=>{
  const result=await api.typeTextTool.handler({text:'ordinary text'},ctx);assert.equal(result.ok,true);assert.equal(counters().typed,'ordinary text');assert.equal(counters().fills,0);assert.ok(counters().screens>0);assert.equal(api.typeTextTool.schema.parameters.required[0],'text')
}))

test('the same reference entry supports card and address fields without returning their values',async()=>fixture(async({api,ctx})=>{
  for(const [kind,field,value] of [['card','number','4242424242424242'],['address','city','Virtual Fixture City']]){
    const item=await api.vault.addVaultItem({kind,label:'Virtual '+kind,origin:'https://fixture.invalid',values:{[field]:value}})
    globalThis.__vaultToolProvider.fillVaultField=async(origin,receivedField,receivedValue)=>{assert.equal(origin,'https://fixture.invalid');assert.equal(receivedField,field);assert.equal(receivedValue,value);return true}
    const result=await api.typeTextTool.handler({text:api.vault.vaultItemRef(item.id),vault_field:field},ctx)
    assert.equal(result.ok,true);assert.ok(!JSON.stringify(result).includes(value));assert.equal(result.screenshot,undefined)
  }
}))
