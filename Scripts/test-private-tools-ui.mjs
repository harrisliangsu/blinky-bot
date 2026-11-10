/** Real React/CSS in our existing Ego Space; the IPC boundary is explicitly mocked. */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runEgoCommand } from '../src/main/tools/computer/browser/egoCli.ts'
import { hydratedEnv } from '../src/main/backends/loginShellEnv.ts'

if (!process.argv[2]) throw new Error('Pass the ownership record of this session’s existing test Space.')
const record = JSON.parse(await readFile(resolve(process.argv[2]), 'utf8'))
assert.ok(Number.isSafeInteger(record.id) && /^blinky-[a-f0-9-]{36}$/.test(record.name))
const root = await mkdtemp(join(tmpdir(), 'blinky-private-tools-ui-')), repo = process.cwd()
await build({ stdin: { resolveDir: repo, loader: 'tsx', contents: `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {SettingsSkills} from './src/renderer/src/components/SettingsSkills';
import {SettingsVault} from './src/renderer/src/components/SettingsVault';import {store} from './src/renderer/src/state';
import './src/renderer/src/tokens.css';import './src/renderer/src/controls.css';import './src/renderer/src/components/SettingsBackends.css';import './src/renderer/src/components/SettingsMcp.css';import './src/renderer/src/components/SettingsTools.css';
store.patch({settings:{language:'zh-CN'}} as any);
let installed=true,items:any[]=[];const calls:any[]=[];(window as any).fixtureCalls=calls;
const skill={id:'agents:fixture-skill',name:'fixture-skill',description:'本地测试技能',origin:'agents',path:'/fixture/shared/fixture-skill',shared:true,updatedAt:1};
const verification=(operation='present')=>[{skill:skill.name,agent:'Codex',operation,status:'verified',detail:'fixture',checkedAt:1},{skill:skill.name,agent:'Claude Code',operation,status:'unsupported',detail:'fixture',checkedAt:1}];
(window as any).openbot={dialog:{pickDirectory:async()=>'/fixture/source'},skills:{list:async()=>installed?[skill]:[],refresh:async()=>installed?[skill]:[],install:async(path:any,opts:any)=>{calls.push(['install',opts.overwrite]);installed=true;return{ok:true,skill,sync:[],verification:verification()}},uninstall:async()=>{calls.push(['remove']);installed=false;return{ok:true,verification:verification('removed')}},syncExisting:async()=>({ok:true,skills:1,linked:1,unavailable:0,issues:[],verification:verification()})},vault:{list:async()=>({ok:true,value:items}),add:async(input:any)=>{if((window as any).failSave)throw Error('fixture-private-error');calls.push(['vault-add',input.values.city==='Fixture city']);const item={id:'11111111-1111-1111-1111-111111111111',kind:input.kind,label:input.label,origin:input.origin,fields:Object.keys(input.values),createdAt:1};items.push(item);return{ok:true,value:item}},remove:async(id:any)=>{items=items.filter(i=>i.id!==id);return{ok:true,value:true}}}};
function Fixture(){const[tab,setTab]=useState('skills');return <><nav><button onClick={()=>setTab('skills')}>技能页面</button><button onClick={()=>setTab('vault')}>保险库页面</button></nav>{tab==='skills'?<SettingsSkills/>:<SettingsVault zh={true}/>}</>}
createRoot(document.getElementById('app')!).render(<Fixture/>);
` }, bundle: true, format: 'iife', platform: 'browser', outfile: join(root, 'app.js'), logLevel: 'silent' })
await writeFile(join(root, 'index.html'), '<meta charset="utf-8"><link rel="stylesheet" href="app.css"><style>body{margin:0;padding:20px;background:var(--ob-bg-editor);color:var(--ob-text-primary);font-family:-apple-system,sans-serif}nav{display:flex;gap:12px;margin-bottom:20px}.ob-hint{font-size:12px;line-height:1.5}</style><div id="app"></div><script src="app.js"></script>')
const server = createServer(async (req, res) => {
  const name = req.url === '/app.js' ? 'app.js' : req.url === '/app.css' ? 'app.css' : 'index.html'
  res.setHeader('content-type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html')
  res.end(await readFile(join(root, name)))
})
await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok) })
const env = await hydratedEnv()
const act = (body) => runEgoCommand(`const task=await taskSpace(${record.id});if(task.name!==${JSON.stringify(record.name)})throw Error('ownership mismatch');const page=task.page('p1');${body}`, env)
try {
  await act(`await page.goto('http://127.0.0.1:${server.address().port}/');await page.waitForSelector('[data-skills]');console.log('__BLINKY_RESULT__'+JSON.stringify((await page.snapshot()).includes('fixture-skill')));`)
  await act(`await page.click('text=同步并验证');await page.waitForSelector('[data-skill-verification]');console.log('__BLINKY_RESULT__'+JSON.stringify(await page.evaluate(()=>document.querySelector('[data-skill-verification]').textContent.includes('发现来源未验证'))));`)
  assert.equal(await act(`await page.click('text=从文件夹更新');await page.waitForSelector('[data-skill-verification]');console.log('__BLINKY_RESULT__'+JSON.stringify(await page.evaluate(()=>window.fixtureCalls.some(c=>c[0]==='install'&&c[1]===true))));`), true)
  const layouts = []
  for (const theme of ['light', 'dark']) for (const width of [1080, 520]) {
    const shot = join(root, `${theme}-${width}-skills.png`)
    const state = await act(`await page.cdp('Emulation.setDeviceMetricsOverride',{width:${width},height:800,deviceScaleFactor:1,mobile:false});await page.evaluate(()=>{document.documentElement.dataset.theme=${JSON.stringify(theme)}});await page.screenshot({path:${JSON.stringify(shot)}});console.log('__BLINKY_RESULT__'+JSON.stringify(await page.evaluate(()=>({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth}))));`)
    assert.equal(state.width, width); assert.equal((await readFile(shot)).readUInt32BE(16), width)
    layouts.push({ theme, width, ...state }); assert.equal(state.overflow, false, 'skills horizontal overflow')
  }
  await act(`await page.click('text=保险库页面');await page.click('text=添加');await page.selectOption('.ob-vault-form select','address');console.log('__BLINKY_RESULT__'+JSON.stringify(true));`)
  // Capture unfilled forms. This harness deliberately never enters passwords
  // into the browser that also hosts the user's password manager.
  for (const theme of ['light', 'dark']) for (const width of [1080, 520]) {
    const shot = join(root, `${theme}-${width}-vault.png`)
    const state = await act(`await page.cdp('Emulation.setDeviceMetricsOverride',{width:${width},height:800,deviceScaleFactor:1,mobile:false});await page.evaluate(()=>{document.documentElement.dataset.theme=${JSON.stringify(theme)}});await page.screenshot({path:${JSON.stringify(shot)}});console.log('__BLINKY_RESULT__'+JSON.stringify(await page.evaluate(()=>({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth}))));`)
    assert.equal(state.width, width); assert.equal((await readFile(shot)).readUInt32BE(16), width)
    assert.equal(state.overflow, false, 'vault horizontal overflow')
  }
  await act(`await page.selectOption('.ob-vault-form select','address');await page.fill('.ob-vault-form label:nth-child(2) input','Fixture address');await page.fill('.ob-vault-form input[type=url]','https://fixture.example');await page.fill('.ob-vault-form label:nth-child(6) input','Fixture city');await page.click('text=安全保存');await page.waitForSelector('.ob-vault-item');console.log('__BLINKY_RESULT__'+JSON.stringify(true));`)
  assert.equal(await act(`console.log('__BLINKY_RESULT__'+JSON.stringify(await page.evaluate(()=>!document.querySelector('.ob-vault').innerHTML.includes('Fixture city')&&window.fixtureCalls.some(c=>c[0]==='vault-add'&&c[1]===true))));`), true)
  await act(`await page.click('text=添加');await page.fill('.ob-vault-form label:nth-child(2) input','Failure fixture');await page.fill('.ob-vault-form label:nth-child(6) input','Fixture city');await page.evaluate(()=>window.failSave=true);await page.click('text=安全保存');await page.waitForSelector('[role=alert]');console.log('__BLINKY_RESULT__'+JSON.stringify(true));`)
  assert.equal(await act(`console.log('__BLINKY_RESULT__'+JSON.stringify(await page.evaluate(()=>!document.querySelector('[role=alert]').textContent.includes('fixture-private-error')&&!document.querySelector('button[type=submit]').disabled)));`), true)
  await act(`await page.click('text=取消');await page.click('text=删除');await page.click('text=确认删除');await page.waitForFunction(()=>!document.querySelector('.ob-vault-item'));console.log('__BLINKY_RESULT__'+JSON.stringify(true));`)
  await act(`await page.goto('http://127.0.0.1:${server.address().port}/');console.log('__BLINKY_RESULT__'+JSON.stringify(true));`)
  const result = { realReact: true, mockedIPC: true, sourceStatusVisible: true, updateUsesOverwrite: true, vaultForm: true, privateErrorHidden: true, confirmedRemoval: true, themesAndWidths: layouts, spaceId: record.id, root }
  await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result))
} finally { server.closeAllConnections(); server.close() }
