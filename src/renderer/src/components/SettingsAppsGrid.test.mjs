// Renders the installed Apps grid without Electron. Hidden connectors stay out of the markup.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const { renderToStaticMarkup } = require('react-dom/server')
const React = require('react')
const resolveDir = dirname(fileURLToPath(import.meta.url))
const result = await build({
  stdin: {
    contents: `export { SettingsApps } from './SettingsApps'; export { OutboundSendRules } from './OutboundSendRules'; export { store } from '../state';`,
    resolveDir,
    loader: 'tsx'
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  jsx: 'automatic',
  loader: { '.css': 'empty' },
  packages: 'external'
})
const text = result.outputFiles[0].text.replace(
  /from "(react(?:\/[^" ]+)?)"/g,
  (_, specifier) => `from ${JSON.stringify(pathToFileURL(require.resolve(specifier)).href)}`
)
const { SettingsApps, OutboundSendRules, store } = await import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`)

const cached = [
  { id: 'github', status: 'connected' },
  { id: 'git', status: 'connected' },
  { id: 'gmail', status: 'connected' },
  { id: 'calendar', status: 'connected' },
  { id: 'slack', status: 'connected' },
  { id: 'x', status: 'disconnected' }
]
function installWindow() {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: { getItem: () => JSON.stringify(cached), setItem: () => {} },
      addEventListener() {},
      removeEventListener() {}
    }
  })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'zh-CN' } })
}

test('Apps grid shows GitHub, Gmail, and X even when Calendar, Slack, and Git are connected', () => {
  installWindow()
  store.patch({ settings: { language: 'zh-CN' }, bots: [], session: null })
  const html = renderToStaticMarkup(React.createElement(SettingsApps))
  assert.match(html, /data-app="github"/)
  assert.match(html, /data-app="gmail"/)
  assert.match(html, /data-app="x"/)
  assert.equal(html.includes('data-app="git"'), false)
  assert.equal(html.includes('data-app="calendar"'), false)
  assert.equal(html.includes('data-app="slack"'), false)
  assert.equal(html.includes('Google Calendar'), false)
  assert.equal(html.includes('Git 设置'), false)
  assert.match(html, /GitHub、Gmail 和 X/)
  assert.match(html, /data-app-view="list"/)
  assert.match(html, />连接</)
  assert.equal(html.includes('重新授权'), false)
  assert.equal(html.includes('断开'), false)
  assert.equal(html.includes('取消授权'), false)
  assert.equal(html.includes('这一版还没有 Google 登录'), false)
  assert.equal(html.includes('Git 和 Gmail'), false)
  assert.equal(html.includes('日程邀请'), false)
  store.patch({ settings: { language: 'zh-CN' }, bots: [{ id: 'bot-1', name: 'Developer', archived: false, computerTarget: { kind: 'local' }, tools: [] }], session: null })
  const detail = renderToStaticMarkup(React.createElement(SettingsApps, { initialApp: 'github' }))
  assert.match(detail, /data-app-view="detail"/)
  assert.match(detail, /重新授权/)
  assert.match(detail, /哪些 Bot 可以使用/)
  assert.match(detail, /高级：自带客户端/)
  const unconnected = renderToStaticMarkup(React.createElement(SettingsApps, { initialApp: 'x' }))
  assert.match(unconnected, />连接</)
  assert.equal(unconnected.includes('取消授权'), false)
  assert.equal(unconnected.includes('>断开<'), false)
  const rules = renderToStaticMarkup(React.createElement(OutboundSendRules))
  assert.match(rules, /自动发送已停用/)
  assert.match(rules, /不会再自动发送邮件/)
  assert.equal(rules.includes('可自动发送'), false)
  assert.equal(rules.includes('尚未保存自动发送规则'), false)
})

test('English Apps copy names GitHub, Gmail, and X', () => {
  installWindow()
  store.patch({ settings: { language: 'en' }, bots: [], session: null })
  const html = renderToStaticMarkup(React.createElement(SettingsApps))
  assert.match(html, /GitHub, Gmail, and X/)
  assert.equal(html.includes('Google sign-in is not in this build'), false)
  assert.equal(html.includes('data-app="calendar"'), false)
  assert.equal(html.includes('data-app="slack"'), false)
  assert.equal(html.includes('data-app="git"'), false)
  assert.equal(html.includes('Reconnect'), false)
  assert.equal(html.includes('Disconnect'), false)
  const rules = renderToStaticMarkup(React.createElement(OutboundSendRules))
  assert.match(rules, /Automatic sending is off/)
  assert.match(rules, /no longer send mail/)
  assert.equal(rules.includes('allow future new messages'), false)
  assert.equal(rules.includes('No automatic send rules saved'), false)
})
