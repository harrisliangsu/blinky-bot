/** Real Ego Browser integration against a local fixture and a test-owned space. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { EgoComputerProvider } from '../src/main/tools/computer/browser/egoProvider.ts'
import { navigateTool } from '../src/main/tools/computer/appTools.ts'

const root = await mkdtemp(path.join(os.tmpdir(), 'blinky-ego-test-'))
let received
let otherVisits = 0
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost')
  if (url.pathname === '/redirect') { response.writeHead(302, { location: `http://localhost:${server.address().port}/other` }); response.end(); return }
  if (url.pathname === '/other') otherVisits++
  if (url.pathname === '/result') { received = url.searchParams.get('value'); response.end('ok'); return }
  response.setHeader('content-type', 'text/html')
  response.end(`<!doctype html><title>Blinky local browser test</title>
    <input id="input" autocomplete="username" style="position:absolute;left:20px;top:20px;width:180px;height:30px">
    <button id="button" style="position:absolute;left:20px;top:70px;width:100px;height:30px">Test</button>
    <script>button.onclick=()=>fetch('/result?value='+encodeURIComponent(input.value))</script>`)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/`
let record
try {
  const browser = new EgoComputerProvider('fixture-bot', root)
  const probe = await browser.probe()
  assert.equal(probe.ok, true, probe.detail)
  await browser.navigate(url)
  const frame = await browser.screenshot()
  assert.ok(frame.width <= 1400 && frame.width > 0 && frame.height > 0 && frame.scale > 0)
  await browser.click(50 * frame.scale, 35 * frame.scale)
  assert.equal(await browser.fillVaultField('http://127.0.0.1:1', 'username', 'wrong-origin-fixture'), false)
  assert.equal(await browser.fillVaultField(new URL(url).origin, 'username', 'vault-fixture'), true)
  await browser.click(50 * frame.scale, 85 * frame.scale)
  for (let i = 0; i < 40 && received === undefined; i++) await new Promise((r) => setTimeout(r, 100))
  assert.equal(received, 'vault-fixture')
  received = undefined
  await browser.click(50 * frame.scale, 35 * frame.scale)
  await browser.keyPress('CMD+A')
  await browser.typeText('local-browser-test')
  await browser.click(50 * frame.scale, 85 * frame.scale)
  for (let i = 0; i < 40 && received === undefined; i++) await new Promise((r) => setTimeout(r, 100))
  assert.equal(received, 'local-browser-test')
  assert.equal(await browser.activeApp(), new URL(url).host)
  record = JSON.parse(await readFile(path.join(root, 'computers', 'fixture-bot', 'ego-space.json'), 'utf8'))
  const resumed = new EgoComputerProvider('fixture-bot', root)
  assert.equal(await resumed.activeApp(), new URL(url).host)
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'computers', 'fixture-bot', 'ego-space.json'), 'utf8')), record)
  const ctx = { sessionId:'test', botId:'fixture-bot', cwd:root, signal:new AbortController().signal, computerTarget:{kind:'browser',botId:'fixture-bot',provider:'ego'}, dataDir:root, settings:{computerUseAllowedApps:['*']}, requestApproval:async()=>false, emit:()=>{} }
  const denied = await navigateTool.handler({url:url+'other'},ctx)
  assert.equal(denied.ok,false)
  assert.equal(otherVisits,0,'refused action must not navigate')
  ctx.settings.computerUseAllowedApps=['127.0.0.1']
  ctx.requestApproval=async()=>true
  const crossSite = await navigateTool.handler({url:'http://example.invalid/',app:'127.0.0.1'},ctx)
  assert.equal(crossSite.ok,false,'a forged app label must not bypass the destination allowlist')
  assert.equal(await resumed.activeApp(),new URL(url).host)
  ctx.requestApproval=async()=>true
  const allowed = await navigateTool.handler({url:url+'other'},ctx)
  assert.equal(allowed.ok,true,allowed.output)
  assert.equal(otherVisits,1)
  assert.ok(allowed.screenshot)
  const redirected = await navigateTool.handler({url:url+'redirect'},ctx)
  assert.equal(redirected.ok,false,'an unauthorized redirect must not return a screenshot')
  assert.equal(redirected.screenshot,undefined)
  console.log(JSON.stringify({ realEgo: true, isolatedSpace: true, screenshot: true, inputAndClick: true, vaultOriginBound: true, resumedById: true, builtInTool: true, approvalGate: true, destinationAllowlist: true, redirectedPageNotReturned: true }))
} finally {
  server.closeAllConnections()
  server.close()
  if (!record) record = await readFile(path.join(root, 'computers', 'fixture-bot', 'ego-space.json'), 'utf8').then(JSON.parse).catch(() => null)
  if (Number.isSafeInteger(record?.id)) {
    await new Promise((resolve) => {
      const child = spawn('ego-browser', ['nodejs'], { stdio: ['pipe', 'ignore', 'ignore'] })
      child.on('error', resolve); child.on('close', resolve)
      child.stdin.end(`const task = await taskSpace(${record.id}); if(task.name === ${JSON.stringify(record.name)}) await task.finish({keep:false});`)
    })
  }
  await rm(root, { recursive: true, force: true })
}
