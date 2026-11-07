/** Only our own Ego Space, a disposable data root and loopback fixture values. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { getComputerProvider, releaseComputerProvidersForBot } from '../src/main/tools/computer/index.ts'
import { browserScopeId } from '../src/main/tools/computer/browserScope.ts'
import { runEgoCommand } from '../src/main/tools/computer/browser/egoCli.ts'
import { hydratedEnv } from '../src/main/backends/loginShellEnv.ts'

const root = process.argv[2] ? resolve(process.argv[2]) : await mkdtemp(join(tmpdir(), 'blinky-browser-validation-'))
let received, submits = 0
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname === '/result') { received = url.searchParams.get('value'); submits++; res.end('ok'); return }
  res.setHeader('content-type', 'text/html')
  res.end(`<html><body><h1 style="position:absolute;left:20px;top:0">Isolated browser fixture</h1>
    <input id="input" autocomplete="username" style="position:absolute;left:20px;top:70px;width:180px;height:30px">
    <button id="button" style="position:absolute;left:20px;top:120px;width:100px;height:30px">Test</button>
    <textarea id="street" autocomplete="shipping street-address" style="position:absolute;left:20px;top:180px;width:200px;height:60px"></textarea>
    <input id="expiry" type="month" autocomplete="cc-exp" style="position:absolute;left:20px;top:270px;width:200px;height:30px">
    <script>button.onclick=()=>fetch('/result?value='+encodeURIComponent(input.value))</script></body></html>`)
})
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
const url = `http://127.0.0.1:${server.address().port}/`, target = { kind: 'browser', botId: 'isolated-browser-fixture', provider: 'ego' }
const options = { botId: target.botId, sessionId: 'fixture-conversation', dataDir: root }
try {
  const browser = getComputerProvider(target, options)
  await browser.navigate(url)
  const frame = await browser.screenshot()
  await writeFile(join(root, 'before.png'), Buffer.from(frame.image, 'base64'))
  assert.ok(frame.width > 0 && frame.width <= 1400 && frame.scale > 0)
  await browser.click(50 * frame.scale, 85 * frame.scale)
  await browser.typeText('fixture-user')
  await browser.click(50 * frame.scale, 135 * frame.scale)
  for (let i = 0; i < 40 && received === undefined; i++) await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(received, 'fixture-user')
  const scope = browserScopeId(target.botId, options.sessionId, root)
  const recordPath = join(root, 'computers', scope.id, 'ego-space.json')
  const record = JSON.parse(await readFile(recordPath, 'utf8'))
  const env = await hydratedEnv()
  const pageState = (body) => runEgoCommand(`const task=await taskSpace(${record.id});if(task.name!==${JSON.stringify(record.name)})throw Error('owner mismatch');const page=task.page('p1');${body}`, env)
  const snapshot = await pageState(`console.log('__BLINKY_RESULT__'+JSON.stringify(await page.snapshot()));`)
  assert.ok(String(snapshot).includes('Isolated browser fixture'))
  await browser.click(50 * frame.scale, 200 * frame.scale)
  assert.equal(await browser.fillVaultField('http://127.0.0.1:1', 'street', 'wrong-site-fixture'), false)
  assert.equal(await browser.fillVaultField(new URL(url).origin, 'street', 'Fixture street\nUnit 2'), true)
  assert.equal(await pageState(`console.log('__BLINKY_RESULT__'+JSON.stringify(await page.evaluate(()=>document.querySelector('#street').value==='Fixture street\\nUnit 2')));`), true)
  await browser.click(70 * frame.scale, 285 * frame.scale)
  assert.equal(await browser.fillVaultField(new URL(url).origin, 'expiry', '2030-11'), true)
  assert.equal(await browser.fillVaultField(new URL(url).origin, 'expiry', '11/30'), false)
  assert.equal(await pageState(`console.log('__BLINKY_RESULT__'+JSON.stringify(await page.evaluate(()=>document.querySelector('#expiry').value==='2030-11')));`), true)
  assert.equal(submits, 1, 'vault fill never submits')
  await releaseComputerProvidersForBot(target.botId)
  const resumed = getComputerProvider(target, options)
  assert.equal(await resumed.activeApp(), new URL(url).host)
  assert.deepEqual(JSON.parse(await readFile(recordPath, 'utf8')), record)
  const result = { realEgo: true, navigation: true, screenshot: true, read: true, inputAndClick: true, originBound: true, streetTextarea: true, expiryMonth: true, noAutomaticSubmit: true, resumedById: true, spaceId: record.id, spaceName: record.name, root }
  await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
  // Preserve this session's owned Space and ownership record, per AGENTS.md.
} finally { await releaseComputerProvidersForBot(target.botId); server.closeAllConnections(); server.close() }
