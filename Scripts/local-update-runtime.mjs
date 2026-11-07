// The external installer's narrow runtime bridge. No model, settings or Vault calls.
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import { connectInspector, inspectInstalledApp, verifiedLoadedMainModules, mainReceiptSignatures, mainTransportSignatures } from './inspect-installed-app.mjs'
import { assertTransportFence, appendOriginalBotReceipt } from './local-update-contracts.mjs'

const cfg = JSON.parse(await fs.readFile(process.argv[2], 'utf8'))
const client = await connectInspector(cfg.port)
let result
try {
  for (let i = 0; i < 200; i++) {
    if (await client.evaluate(`process.getBuiltinModule('module').createRequire(process.execPath)('electron').app.isReady()`)) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const runtime = await client.evaluate(`(()=>{const e=process.getBuiltinModule('module').createRequire(process.execPath)('electron');return{pid:process.pid,appPath:e.app.getAppPath(),userData:e.app.getPath('userData')}})()`)
  assert.equal(runtime.appPath, cfg.appPath)
  assert.equal(runtime.userData, cfg.dataDir)
  if (cfg.expectedPid !== undefined) assert.equal(runtime.pid, cfg.expectedPid)
  const ui = expression => client.evaluate(`(async()=>{const e=process.getBuiltinModule('module').createRequire(process.execPath)('electron'),w=e.BrowserWindow.getAllWindows().find(w=>!w.isDestroyed());if(!w)throw Error('No application window');return w.webContents.executeJavaScript(${JSON.stringify(expression)})})()`)
  const liveOperation = async (signatures, input, operation) => {
    const group = 'local-update-live-operation'
    const proto = await client.send('Runtime.evaluate', { expression: 'Function.prototype', returnByValue: false })
    const array = await client.send('Runtime.queryObjects', { prototypeObjectId: proto.result.objectId, objectGroup: group })
    try {
      const value = await client.send('Runtime.callFunctionOn', {
        objectId: array.objects.objectId, returnByValue: true,
        arguments: [{ value: signatures }, { value: input }],
        functionDeclaration: `function(signatures,cfg){const api={};for(const[key,source]of Object.entries(signatures)){const matches=this.filter(f=>typeof f==='function'&&Function.prototype.toString.call(f)===source);if(matches.length!==1)throw Error('Ambiguous application function');api[key]=matches[0]}return (${operation})(api,cfg)}`
      })
      if (value.exceptionDetails) throw Error(value.exceptionDetails.exception?.description ?? 'Application contract operation failed')
      return value.result.value
    } finally { await client.send('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => {}) }
  }
  const liveFence = async quit => {
    assert.ok(cfg.transportTaskId && cfg.transportTaskSessionId && cfg.sourceSessionId && cfg.originalBotId)
    const signatures = mainTransportSignatures(await verifiedLoadedMainModules(client, cfg.appPath))
    const operation = quit ? `function(api,cfg){const proof=(${assertTransportFence.toString()})(api,cfg);process.getBuiltinModule('module').createRequire(process.execPath)('electron').app.quit();return{normalQuitRequested:true,transportFence:proof}}` : assertTransportFence.toString()
    return liveOperation(signatures, cfg, operation)
  }
  if (cfg.action === 'read') {
    result = await inspectInstalledApp(cfg)
  } else if (cfg.action === 'gate') {
    const transportFence = cfg.requireTransport ? await liveFence(false) : undefined
    result = { runtime, transportFence, ...await ui(`(async()=>{const tasks=await window.openbot.tasks.summaries();const sessions=await window.openbot.sessions.list();return{tasks:tasks.map(t=>({id:t.id,status:t.status,sessionId:t.sessionId,sourceSessionId:t.sourceSessionId,deliveryStatus:t.deliveryStatus})),runs:await Promise.all(sessions.map(async s=>({id:s.id,running:await window.openbot.agent.isRunning(s.id)})))}})()`) }
  } else if (cfg.action === 'quit') {
    // Fence and normal app.quit execute synchronously in the same main stack.
    // Normal lifecycle owns cancellation and flushing; no terminal task forgery.
    result = { runtime, ...await liveFence(true) }
  } else if (cfg.action === 'close-inspector') {
    result = { runtime, inspectorCloseRequested: true }
    await client.evaluate(`(()=>{setTimeout(()=>process.getBuiltinModule('inspector').close(),250);return true})()`)
  } else if (cfg.action === 'receipt') {
    assert.ok(cfg.sourceSessionId && cfg.receiptId && cfg.receiptText && cfg.originalBotId)
    const signatures = mainReceiptSignatures(await verifiedLoadedMainModules(client, cfg.appPath))
    result = { runtime, ...await liveOperation(signatures, { sid: cfg.sourceSessionId, id: cfg.receiptId, text: cfg.receiptText, originalBotId: cfg.originalBotId }, appendOriginalBotReceipt.toString()) }
  } else {
    throw Error('Unknown installer action')
  }
  await fs.writeFile(cfg.output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify(result))
} finally {
  client.close()
}
