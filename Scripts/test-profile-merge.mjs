/** Targeted merge checks: real renderer modules and preload, synthetic IPC only.
 * No Electron launch, native picker, network, or existing user data. */
import assert from 'node:assert/strict'
import { test,after } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const repo=process.cwd(),temp=await fs.mkdtemp(path.join(os.tmpdir(),'blinky-profile-merge-'))
const baseline=process.env.BLINKY_MERGE_BASELINE||path.resolve(repo,'../baseline')
const { Window }=await import(pathToFileURL(process.env.BLINKY_DOM_MODULE||'./node_modules/happy-dom/lib/index.js').href)
const window=new Window({url:'https://isolated.invalid',settings:{disableJavaScriptFileLoading:true,disableCSSFileLoading:true,enableFileSystemHttpRequests:false}})
for(const key of ['window','document','HTMLElement','Element','Node','Event','MutationObserver'])Object.defineProperty(globalThis,key,{configurable:true,value:key==='window'?window:key==='document'?window.document:window[key]})
Object.defineProperty(globalThis,'navigator',{configurable:true,value:window.navigator})
globalThis.requestAnimationFrame=window.requestAnimationFrame.bind(window)
globalThis.cancelAnimationFrame=window.cancelAnimationFrame.bind(window)
globalThis.IS_REACT_ACT_ENVIRONMENT=true
globalThis.fetch=window.fetch=()=>{throw Error('No network allowed')}
const NativeMessageChannel=globalThis.MessageChannel,channels=[]
globalThis.MessageChannel=class extends NativeMessageChannel{constructor(){super();channels.push(this)}}
after(async()=>{await window.happyDOM.abort();window.happyDOM.close();for(const c of channels){c.port1.close();c.port2.close()}globalThis.MessageChannel=NativeMessageChannel;delete globalThis.__mergePreload;await fs.rm(temp,{recursive:true,force:true})})

async function preload(root,name){
 const result=await build({entryPoints:[path.join(root,'src/preload/index.ts')],bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'fake-electron-only',setup(b){b.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`export const contextBridge={exposeInMainWorld:(_name,api)=>globalThis.__mergePreload=api};export const ipcRenderer={invoke:async(channel,...args)=>({channel,args}),on(){},removeListener(){}};`}))}}]})
 const file=path.join(temp,name+'.mjs');await fs.writeFile(file,result.outputFiles[0].text);await import(pathToFileURL(file).href);return globalThis.__mergePreload
}
async function checkPreload(){
 const before=await preload(baseline,'before'),merged=await preload(repo,'merged')
 const paths=(object,prefix='')=>Object.entries(object).flatMap(([key,value])=>typeof value==='function'?[prefix+key]:value&&typeof value==='object'?paths(value,prefix+key+'.'):[])
 const oldPaths=paths(before),newPaths=paths(merged)
 for(const key of oldPaths)assert.ok(newPaths.includes(key),key)
 assert.equal(newPaths.length,oldPaths.length+1)
 assert.deepEqual(await merged.settings.get(),await before.settings.get())
 assert.deepEqual(await merged.settings.update({theme:'dark'}),await before.settings.update({theme:'dark'}))
 assert.deepEqual(await merged.settings.saveProfile({profileName:'Fixture'}),{channel:'openbot:settings:saveProfile',args:[{profileName:'Fixture'}]})
 assert.deepEqual(await merged.sendRules.list(),await before.sendRules.list())
 assert.deepEqual(await merged.gmailDrafts.act('draft','session','confirm-send'),await before.gmailDrafts.act('draft','session','confirm-send'))
}

const built=await build({stdin:{contents:`import React from 'react';export const act=React.act,createElement=React.createElement;export {createRoot} from 'react-dom/client';export {SettingsPanel} from './src/renderer/src/components/SettingsPanel';export {Sidebar} from './src/renderer/src/components/Sidebar';export {store} from './src/renderer/src/state/core';export {saveUserProfile} from './src/renderer/src/state/preferences';export {defaultSettings} from './src/main/settingsSchema';`,resolveDir:repo,loader:'tsx'},bundle:true,platform:'node',format:'esm',write:false,loader:{'.css':'empty'},define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'unrelated-assets-and-panels',setup(b){b.onResolve({filter:/\/(BotAvatar|SettingsApps|SettingsBackends|SettingsVault)$/},args=>({path:args.path.split('/').at(-1),namespace:'panel'}));b.onLoad({filter:/.*/,namespace:'panel'},args=>({contents:`export const ${args.path}=()=>null`,loader:'js'}))}}]})
const moduleFile=path.join(temp,'renderer.mjs');await fs.writeFile(moduleFile,built.outputFiles[0].text)
const {act,createElement,createRoot,SettingsPanel,Sidebar,store,saveUserProfile,defaultSettings}=await import(pathToFileURL(moduleFile).href)
let host,root,current,writes=[],fail=false
async function mount(){
 current={...defaultSettings(),language:'en',profileName:'Legacy User',profileEmoji:'L',profileColor:'#123456',quickDecision:{backendId:'openai',modelId:'route-fixture'}};writes=[];fail=false
 window.openbot={settings:{get:async()=>current,update:async patch=>(current={...current,...patch}),saveProfile:async patch=>{writes.push(patch);return fail?{ok:false,error:'Synthetic storage error'}:{ok:true,settings:(current={...current,...patch})}}},sendRules:{list:async()=>({ok:true,rules:[]})},routines:{backgroundStatus:async()=>({state:'disabled'})},on:()=>()=>{}}
 store.patch({ready:true,settings:current,modal:'settings',bots:[],backends:[],backendsLoading:false})
 host=document.createElement('div');document.body.append(host);root=createRoot(host)
 await act(async()=>root.render(createElement('div',null,createElement(Sidebar),createElement(SettingsPanel))))
}
async function unmount(){await act(async()=>root.unmount());host.remove()}
test('merged preload retains every captured API and aligns the profile channel',checkPreload)
test('captured routing and send-rule panels coexist with the new profile form',async()=>{
 await mount()
 try{
  await act(async()=>host.querySelector('#ob-set-tab-bots').click())
  assert.match(host.textContent,/Optional routing model/);assert.ok(host.querySelector('.ob-send-rules'))
  await act(async()=>host.querySelector('#ob-set-tab-profile').click())
  assert.ok(host.querySelector('.ob-user-profile [data-profile-name]'))
  assert.ok(host.querySelector('.ob-user-profile [data-profile-file]'))
  assert.equal(host.querySelectorAll('.ob-user-profile').length,1)
  assert.equal(host.querySelector('[data-profile-name]').value,'Legacy User')
  await act(async()=>host.querySelector('#ob-set-tab-bots').click())
  assert.match(host.textContent,/Optional routing model/);assert.ok(host.querySelector('.ob-send-rules'))
 }finally{await unmount()}
})
test('profile bridge success updates both identity views and failure retains them',async()=>{
 await mount()
 try{
  await act(async()=>host.querySelector('#ob-set-tab-profile').click())
  let result;await act(async()=>{result=await saveUserProfile({profileName:'Merged Reader'})})
  assert.equal(result.ok,true);assert.equal(host.querySelector('.ob-side-profile > span:last-child').textContent,'Merged Reader')
  assert.equal(host.querySelector('[data-profile-name]').value,'Merged Reader')
  assert.match(host.querySelector('.ob-profile-preview').textContent,/Merged Reader/)
  assert.deepEqual(store.getState().settings.quickDecision,{backendId:'openai',modelId:'route-fixture'})
  fail=true;await act(async()=>{result=await saveUserProfile({profileName:'Must Not Publish'})})
  assert.equal(result.ok,false);assert.equal(host.querySelector('[data-profile-name]').value,'Merged Reader')
  assert.equal(host.querySelector('.ob-side-profile > span:last-child').textContent,'Merged Reader')
  assert.deepEqual(writes,[{profileName:'Merged Reader'},{profileName:'Must Not Publish'}])
 }finally{await unmount()}
})
