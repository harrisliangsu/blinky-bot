// Read-only post-install evidence. Never pauses, quits, restarts, writes a
// receipt into a conversation, or requests settings/credentials/transcripts.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { extractFile } from '@electron/asar'

const sha = value => createHash('sha256').update(value).digest('hex')
// Follow the actual static ES-module graph, including older single-file builds.
// Dynamic/lazy modules are not evidence until a caller explicitly loads them.
export function mainModuleClosure(appPath, read = name => extractFile(appPath, name).toString('utf8')) {
  const modules = new Map()
  const visit = name => {
    if (modules.has(name)) return
    assert.ok(name.startsWith('out/main/') && name.endsWith('.js'), 'Main module must remain inside the ASAR main directory')
    const source = read(name)
    modules.set(name, { path: name, source, sha256: sha(source) })
    const imports = /^\s*(?:import\s+(?:[^;\n]*?\s+from\s+)?|export\s+[^;\n]*?\s+from\s+)(["'])(\.[^"'\r\n]+)\1\s*;?/gm
    for (const match of source.matchAll(imports)) visit(path.posix.normalize(path.posix.join(path.posix.dirname(name), match[2])))
  }
  visit('out/main/index.js')
  return [...modules.values()]
}

export async function verifiedLoadedMainModules(client, appPath, modules = mainModuleClosure(appPath)) {
  const scripts = []
  const stop = client.on(event => { if (event.method === 'Debugger.scriptParsed') scripts.push(event.params) })
  let enabled = false
  try {
    await client.send('Debugger.enable'); enabled = true
    for (const module of modules) {
      const absolute = path.join(appPath, module.path), url = pathToFileURL(absolute).href
      const matches = scripts.filter(item => decodeURIComponent(item.url) === decodeURIComponent(url) || decodeURIComponent(item.url) === absolute)
      assert.equal(matches.length, 1, 'Main module must have one actual loaded script: ' + module.path)
      const loaded = (await client.send('Debugger.getScriptSource', { scriptId: matches[0].scriptId })).scriptSource
      assert.equal(sha(loaded), module.sha256, 'Loaded module must equal installed ASAR bytes: ' + module.path)
    }
    return modules
  } finally { stop(); if (enabled) await client.send('Debugger.disable').catch(() => {}) }
}

export function mainModulePolicy(modules) {
  const result = {}
  for (const [key, name] of Object.entries({ maxConcurrent: 'MAX_CONCURRENT_RUNS', maxQueuedPerBot: 'MAX_QUEUED_TASKS_PER_BOT', maxQueued: 'MAX_QUEUED_TASKS' })) {
    const declarations = modules.flatMap(module => [...module.source.matchAll(new RegExp(`\\b(?:const|let|var) ${name}\\s*=`, 'g'))])
    assert.equal(declarations.length, 1, name + ' must have exactly one declaration in verified loaded modules')
    const matches = modules.flatMap(module => [...module.source.matchAll(new RegExp(`\\bconst ${name} = ([0-9_]+(?:e[+-]?[0-9]+)?);`, 'g'))])
    assert.equal(matches.length, 1, name + ' must have exactly one immutable literal in verified loaded modules')
    result[key] = Number(matches[0][1].replaceAll('_', ''))
  }
  assert.deepEqual(result, { maxConcurrent: 4, maxQueuedPerBot: 10000, maxQueued: 50000 })
  return result
}

export function mainFunctionSignatures(modules, names) {
  const take = name => {
    const candidates = modules.flatMap(module => [...module.source.matchAll(new RegExp(`\\bfunction ${name}\\(`, 'g'))].map(match => {
      const end = module.source.indexOf('\n}', match.index)
      assert.ok(end > match.index, 'Receipt function must have a complete source body')
      return module.source.slice(match.index, end + 2)
    }))
    // getTask is emitted as a one-line collection getter in both actual builds.
    // Accept only that exact arrow shape, never arbitrary assignment/eval text.
    if(name==='getTask')for(const module of modules){
      for(const match of module.source.matchAll(/^const getTask = (\(([A-Za-z_$][\w$]*)\) => [A-Za-z_$][\w$]*\.get\(\2\));$/gm))candidates.push(match[1])
    }
    assert.equal(candidates.length, 1, 'Receipt function must be unique in verified loaded modules: ' + name)
    return candidates[0]
  }
  return Object.fromEntries(Object.entries(names).map(([key,name])=>[key,take(name)]))
}

export function mainTransportSignatures(modules) {
  return mainFunctionSignatures(modules,{task:'getTask',get:'getSession',bot:'getBot',running:'isRunning',suspended:'isQueueSuspended',cancelled:'isStartCancelled'})
}

export function mainReceiptSignatures(modules) {
  const signatures = mainFunctionSignatures(modules,{get:'getSession',save:'saveSession',bot:'getBot'})
  const broadcasts = modules.flatMap(module => [...module.source.matchAll(/  sendNativeEvent\(event\);/g)].map(match => {
    const begin = module.source.lastIndexOf('function ', match.index), end = module.source.indexOf('\n}', match.index)
    assert.ok(begin >= 0 && end > match.index)
    return module.source.slice(begin, end + 2)
  }))
  assert.equal(broadcasts.length, 1, 'Receipt broadcast must be unique in verified loaded modules')
  assert.ok(broadcasts[0].includes('EVENT_CHANNEL'))
  return { ...signatures, broadcast: broadcasts[0] }
}

// Also runs, by function source, inside the identity-checked Electron main.
// Refuse an existing debugger; detach only the attachment created here.
export async function verifyRendererDebuggerSources(debuggerClient, expected, hash) {
  if (debuggerClient.isAttached()) throw Error('Renderer debugger is already attached; refusing to take it over')
  const scripts = [], listener = (_event, method, parameters) => { if (method === 'Debugger.scriptParsed') scripts.push(parameters) }
  let attached = false, modules = []
  debuggerClient.on('message', listener)
  try {
    debuggerClient.attach('1.3'); attached = true
    await debuggerClient.sendCommand('Debugger.enable')
    for (const module of expected) {
      const matches = scripts.filter(script => { try { return decodeURIComponent(new URL(script.url).pathname) === module.path } catch { return false } })
      if (matches.length !== 1) throw Error('Renderer module must have one actual loaded script: ' + module.path)
      const loaded = await debuggerClient.sendCommand('Debugger.getScriptSource', { scriptId: matches[0].scriptId })
      const loadedSha256 = hash(loaded.scriptSource)
      if (loadedSha256 !== module.sha256) throw Error('Loaded renderer module differs from ASAR bytes: ' + module.path)
      modules.push({ path: module.path, loadedSha256, asarSha256: module.sha256, matchesAsar: true })
    }
  } finally {
    if (attached) await debuggerClient.sendCommand('Debugger.disable').catch(() => {})
    debuggerClient.removeListener('message', listener)
    if (attached) debuggerClient.detach()
  }
  if (debuggerClient.isAttached()) throw Error('Temporary renderer debugger was not detached')
  return { modules, temporaryDebuggerDetached: true }
}

export async function connectInspector(port, type) {
  let target
  for (let i=0;i<50;i++) {
    try { target=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item=>!type||item.type===type);if(target)break } catch {}
    await delay(100)
  }
  if(!target)throw Error('No inspector target at the requested local port')
  const ws=new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject})
  let seq=0;const pending=new Map(),listeners=new Set()
  ws.onmessage=event=>{
    const value=JSON.parse(event.data),item=pending.get(value.id)
    if(item){pending.delete(value.id);clearTimeout(item.timer);value.error?item.reject(Error(value.error.message)):item.resolve(value.result)}
    else for(const listener of listeners)listener(value)
  }
  const send=(method,params={})=>new Promise((resolve,reject)=>{
    const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(Error(`Inspector timeout: ${method}`))},8000)
    pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}))
  })
  const evaluate=async expression=>{
    const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})
    if(result.exceptionDetails)throw Error('Read-only runtime evaluation failed')
    return result.result.value
  }
  return {send,evaluate,on(listener){listeners.add(listener);return()=>listeners.delete(listener)},close(){ws.close()}}
}

export async function inspectInstalledApp(cfg) {
  assert.ok(Number.isInteger(cfg.port)&&cfg.port>0)
  const client=await connectInspector(cfg.port)
  try {
    await client.send('Runtime.enable')
    let runtime,ready=false,lastReadinessError
    const readyDeadline=Date.now()+30000,expectedRendererIndex=path.join(cfg.appPath,'out/renderer/index.html')
    while(Date.now()<readyDeadline){
      let candidate
      try{candidate=await client.evaluate(`(()=>{const e=process.getBuiltinModule('module').createRequire(process.execPath)('electron');if(!e.app.isReady())return{ready:false};const w=e.BrowserWindow.getAllWindows().find(w=>!w.isDestroyed());let rendererPath=null;try{rendererPath=decodeURIComponent(new URL(w?.webContents.getURL()).pathname)}catch{}return{pid:process.pid,execPath:process.execPath,appPath:e.app.getAppPath(),userData:e.app.getPath('userData'),isPackaged:e.app.isPackaged,ready:true,windows:e.BrowserWindow.getAllWindows().filter(w=>!w.isDestroyed()).length,rendererPath,rendererLoading:w?w.webContents.isLoadingMainFrame():true}})()`)}catch(error){lastReadinessError=String(error)}
      if(candidate?.ready){
        assert.equal(candidate.appPath,cfg.appPath);assert.equal(candidate.userData,cfg.dataDir)
        if(cfg.expectedPid!==undefined)assert.equal(candidate.pid,cfg.expectedPid)
        runtime=candidate
        if(candidate.rendererPath===expectedRendererIndex&&!candidate.rendererLoading){
          try{ready=await client.evaluate(`(async()=>{const e=process.getBuiltinModule('module').createRequire(process.execPath)('electron'),w=e.BrowserWindow.getAllWindows().find(w=>!w.isDestroyed());return w.webContents.executeJavaScript("document.readyState==='complete'&&Boolean(window.openbot)&&Boolean(document.querySelector('#ob-prompt'))")})()`)}catch(error){lastReadinessError=String(error)}
          if(ready)break
        }
      }
      await delay(100)
    }
    assert.ok(ready,'Own application/renderer/composer did not become ready within 30s: '+(lastReadinessError??'readiness conditions unmet'))
    assert.ok(runtime.isPackaged&&runtime.ready&&runtime.windows>0)
    const asarSha256=sha(await fs.readFile(cfg.appPath))
    if(cfg.asarSha256)assert.equal(asarSha256,cfg.asarSha256)
    const modules=await verifiedLoadedMainModules(client,cfg.appPath)
    const sourcePolicy=mainModulePolicy(modules)
    const rendererHtml=extractFile(cfg.appPath,'out/renderer/index.html').toString('utf8')
    const rendererIndex=pathToFileURL(path.join(cfg.appPath,'out/renderer/index.html'))
    const rendererScripts=[...rendererHtml.matchAll(/<script\b[^>]*>/g)].filter(match=>/\btype=["']module["']/.test(match[0])).map(match=>/\bsrc=["']([^"']+)["']/.exec(match[0])?.[1]).filter(Boolean)
    assert.ok(rendererScripts.length>0,'ASAR must name its renderer module')
    const rendererPaths=rendererScripts.map(src=>decodeURIComponent(new URL(src,rendererIndex).pathname))
    const started=performance.now()
    const rendererExpression=`(()=>{const expected=${JSON.stringify(rendererPaths)},index=${JSON.stringify(decodeURIComponent(rendererIndex.pathname))};const localPath=u=>{try{return decodeURIComponent(new URL(u,location.href).pathname)}catch{return null}};const scripts=[...document.scripts].filter(s=>s.type==='module').map(s=>localPath(s.src));const resources=performance.getEntriesByType('resource').map(r=>localPath(r.name));return{readyState:document.readyState,bridgeAvailable:Boolean(window.openbot),composerAvailable:Boolean(document.querySelector('#ob-prompt')),nodes:document.querySelectorAll('*').length,rendererIndexMatchesAsar:localPath(location.href)===index,rendererModulesMatchAsar:expected.every(p=>scripts.includes(p)),rendererResourceModulesVisible:expected.every(p=>resources.includes(p))}})()`
    const ui=await client.evaluate(`(async()=>{const e=process.getBuiltinModule('module').createRequire(process.execPath)('electron'),w=e.BrowserWindow.getAllWindows().find(w=>!w.isDestroyed());return w.webContents.executeJavaScript(${JSON.stringify(rendererExpression)})})()`)
    assert.equal(ui.readyState,'complete');assert.equal(ui.bridgeAvailable,true);assert.equal(ui.composerAvailable,true)
    assert.equal(ui.rendererIndexMatchesAsar,true);assert.equal(ui.rendererModulesMatchAsar,true)
    const rendererExpected=rendererScripts.map((src,i)=>({path:rendererPaths[i],sha256:sha(extractFile(cfg.appPath,path.posix.join('out/renderer',src)))}))
    const rendererLoaded=await client.evaluate(`(async()=>{const e=process.getBuiltinModule('module').createRequire(process.execPath)('electron'),w=e.BrowserWindow.getAllWindows().find(w=>!w.isDestroyed());if(decodeURIComponent(new URL(w.webContents.getURL()).pathname)!==${JSON.stringify(decodeURIComponent(rendererIndex.pathname))})throw Error('Renderer window identity changed');return (${verifyRendererDebuggerSources.toString()})(w.webContents.debugger,${JSON.stringify(rendererExpected)},source=>process.getBuiltinModule('crypto').createHash('sha256').update(source).digest('hex'))})()`)
    assert.equal(rendererLoaded.temporaryDebuggerDetached,true)
    return {ok:true,readOnly:true,runtime,asarSha256,loadedModuleSha256:modules[0].sha256,loadedMainModules:modules.map(({path,sha256})=>({path,sha256})),loadedModuleMatchesAsar:true,sourcePolicy,rendererLoadedModules:rendererLoaded.modules,temporaryRendererDebuggerDetached:true,rendererModules:rendererScripts.map(src=>({path:src,asarSha256:sha(extractFile(cfg.appPath,path.posix.join('out/renderer',src)))})),ui:{...ui,probeMs:Math.round(performance.now()-started)},boundary:'Actual loaded main static modules and renderer entry-module source hashes match ASAR; DOM source URLs also match. file: performance resource entries may be unavailable. No credential, transcript, backup integrity, task replay or installation-completion claim.'}
  } finally {
    client.close()
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const cfg=JSON.parse(await fs.readFile(process.argv[2],'utf8'))
  const result=await inspectInstalledApp(cfg)
  await fs.writeFile(cfg.output,JSON.stringify(result,null,2)+'\n')
  console.log(JSON.stringify(result))
}
