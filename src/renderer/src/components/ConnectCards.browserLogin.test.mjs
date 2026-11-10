// Node-only checks: real React server rendering plus an isolated hook adapter
// for event closures. No DOM, Electron, browser or real IPC is started.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const require = createRequire(import.meta.url)
const React = require('react'), { renderToStaticMarkup } = require('react-dom/server')
const resolveDir = dirname(fileURLToPath(import.meta.url))
const source = `export {GoogleConnectCard} from './GoogleConnectCard'; export {XConnectCard} from './XConnectCard'; export {GitHubConnectCard} from './GitHubConnectCard';`
async function compile(events) {
  const result = await build({stdin:{contents:source,resolveDir,loader:'tsx'},bundle:true,platform:'node',format:'esm',write:false,jsx:'automatic',loader:{'.css':'empty'},packages:'external',plugins:events?[{name:'event-hooks',setup(b){
    b.onResolve({filter:/^react$/},()=>({path:'hooks',namespace:'fixture'}))
    b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:`
      export const useState=v=>globalThis.__connectionHooks.state(v);
      export const useRef=v=>globalThis.__connectionHooks.ref(v);
      export const useEffect=()=>{}; export const useSyncExternalStore=()=>({});`,loader:'js'}))
    b.onResolve({filter:/^\.\/Modal$/},()=>({path:'modal',namespace:'fixture-modal'}))
    b.onLoad({filter:/.*/,namespace:'fixture-modal'},()=>({contents:`export const Modal=({children})=>children;`,loader:'js'}))
  }}]:[]})
  // Resolve external React against this test's own package; no app code executes.
  const text = result.outputFiles[0].text.replace(/from "(react(?:\/[^" ]+)?)"/g,(_,s)=>`from ${JSON.stringify(pathToFileURL(require.resolve(s)).href)}`)
  return import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`)
}
const real = await compile(false), isolated = await compile(true)
const text = node => node == null || typeof node==='boolean' ? '' : typeof node==='string'||typeof node==='number' ? String(node) : Array.isArray(node) ? node.map(text).join('') : text(node.props?.children)
function nodes(node, type) { if (!node || typeof node!=='object') return []; if (Array.isArray(node)) return node.flatMap(n=>nodes(n,type)); return [...(node.type===type?[node]:[]), ...nodes(node.props?.children,type)] }
function mount(Component, initial) {
  const slots=[], refs=[]; let cursor=0, refCursor=0, tree, props=initial
  const render=()=>{cursor=0;refCursor=0;globalThis.__connectionHooks={state(v){const i=cursor++;if(!(i in slots))slots[i]=v;return[slots[i],n=>{slots[i]=typeof n==='function'?n(slots[i]):n}]},ref(v){return refs[refCursor++]??(refs[refCursor-1]={current:v})}};tree=Component(props);return tree}
  return {render,update(next){props={...props,...next};return render()},button(label){const found=nodes(tree,'button').find(n=>text(n)===label);assert.ok(found,`Missing button: ${label}`);return found},click(label){const b=this.button(label);assert.ok(!b.props.disabled,`Disabled button: ${label}`);b.props.onClick();render()},get tree(){return tree}}
}
const props = (id, detail='oauth-client-required') => ({zh:true,service:'gmail',status:{id,status:'disconnected',detail},statusLabel:'未连接',refresh(){}})

test('unconfigured Google, X, and GitHub render distributor-owned status without a developer form in either language', () => {
  for (const [name,id] of [['GoogleConnectCard','gmail'],['XConnectCard','x'],['GitHubConnectCard','github']]) for (const zh of [true,false]) {
    const html=renderToStaticMarkup(React.createElement(real[name],{...props(id),zh}))
    assert.match(html,/disabled=""/);assert.match(html,zh?/发行方/:/distributor/)
    if (id === 'github') assert.match(html, /gh auth/)
    assert.ok(!html.includes('<input'));assert.ok(!html.includes('Set up connection'));assert.ok(!html.includes('配置连接'))
    assert.match(html,zh?/高级：自带客户端/:/Advanced: bring your own client/)
  }
})
test('missing client cannot initiate OAuth; manual configuration is an explicit advanced action', () => {
  for (const [name,id] of [['GoogleConnectCard','gmail'],['XConnectCard','x'],['GitHubConnectCard','github']]) {
    const calls=[];globalThis.window={openbot:{apps:new Proxy({}, {get:()=> (...args)=>{calls.push(args);return Promise.resolve({ok:true})}})}}
    const m=mount(isolated[name],props(id));m.render()
    assert.equal(m.button('浏览器登录暂不可用').props.disabled,true)
    m.button('浏览器登录暂不可用').props.onClick();m.render();assert.equal(calls.length,0)
    assert.equal(nodes(m.tree,'input').length,0);m.click('高级：自带客户端…')
    assert.ok(nodes(m.tree,'input').length>0);assert.equal(calls.length,0)
  }
})
test('ready Google, X, and GitHub start browser sign-in with empty renderer client fields and show rejected authorization', async () => {
  for (const [name,id,expected] of [['GoogleConnectCard','gmail',['gmail','','',undefined]],['XConnectCard','x',['']],['GitHubConnectCard','github',['','']]]) {
    const calls=[];globalThis.window={openbot:{apps:{connectGoogle:(...a)=>{calls.push(a);return Promise.resolve({ok:false})},connectX:(...a)=>{calls.push(a);return Promise.resolve({ok:false})},connectGitHub:(...a)=>{calls.push(a);return Promise.resolve({ok:false})}}}}
    const m=mount(isolated[name],props(id,'oauth-ready'));m.render();m.click('浏览器登录')
    assert.deepEqual(calls,[expected]);assert.equal(nodes(m.tree,'input').length,0)
    await new Promise(resolve=>setImmediate(resolve));m.render();assert.match(text(m.tree),/授权未完成/)
  }
})
test('account selection, reconnect and adding an account preserve the selected account options', async () => {
  const calls=[];globalThis.window={openbot:{apps:{connectGoogle:(...a)=>{calls.push(a);return Promise.resolve({ok:true})}}}}
  const m=mount(isolated.GoogleConnectCard,{...props('gmail','oauth-ready'),status:{id:'gmail',status:'connected',accounts:[{id:'A',label:'A fixture',isDefault:true,status:'connected'},{id:'B',label:'B fixture',isDefault:false,status:'connected'}]}})
  m.render();nodes(m.tree,'select')[0].props.onChange({target:{value:'B'}});m.render();assert.equal(calls.length,0)
  m.click('重新授权此账户');assert.deepEqual(calls[0],['gmail','','',{accountId:'B'}])
  await new Promise(resolve=>setImmediate(resolve));m.render();m.click('添加其他账号')
  assert.deepEqual(calls[1],['gmail','','',{addAccount:true}])
})
