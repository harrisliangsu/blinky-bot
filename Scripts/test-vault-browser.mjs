/** Isolated headless Chrome provider and fixture site; no real account or secret. */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { BrowserComputerProvider } from '../src/main/tools/computer/browser/provider.ts'
import { DEFAULT_SPEC } from '../src/main/tools/computer/browser/chrome.ts'

const root = await mkdtemp(path.join(os.tmpdir(), 'blinky-vault-chrome-'))
let received
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (url.pathname === '/result') { received = url.searchParams.get('value'); res.end('ok'); return }
  res.setHeader('content-type', 'text/html')
  res.end('<input id="input" autocomplete="username" style="position:absolute;left:20px;top:20px;width:180px;height:30px"><button id="button" style="position:absolute;left:20px;top:70px;width:100px;height:30px">Test</button><script>button.onclick=()=>fetch("/result?value="+encodeURIComponent(input.value))</script>')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/`, browser = new BrowserComputerProvider({ botId: 'fixture', ...DEFAULT_SPEC }, root)
try {
  await browser.navigate(url); const frame = await browser.screenshot()
  await browser.click(50 * frame.scale, 35 * frame.scale)
  assert.equal(await browser.fillVaultField('http://127.0.0.1:1', 'username', 'wrong-origin'), false)
  assert.equal(await browser.fillVaultField(new URL(url).origin, 'username', 'vault-fixture'), true)
  await browser.click(50 * frame.scale, 85 * frame.scale)
  for (let i = 0; i < 40 && received === undefined; i++) await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(received, 'vault-fixture')
  console.log(JSON.stringify({ realChromeProvider: true, isolatedProfile: true, exactOrigin: true, matchingField: true }))
} finally { await browser.stop(); server.closeAllConnections(); server.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) }
