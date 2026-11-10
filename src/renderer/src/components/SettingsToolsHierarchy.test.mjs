// Static render of the Tools page: tools view first, builtins absent, sync choice visible.
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
    contents: `export { SettingsTools } from './SettingsTools'; export { SystemPermissionList } from './SystemPermissions'; export { store } from '../state';`,
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
const { SettingsTools, SystemPermissionList, store } = await import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`)

function installWindow() {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      localStorage: { getItem: () => null, setItem: () => {} },
      openbot: {
        environment: { kind: 'desktop' },
        skills: { list: async () => [], refresh: async () => [], install: async () => ({ ok: false }), uninstall: async () => ({ ok: false }), syncExisting: async () => ({ ok: true, skills: 0, linked: 0, unavailable: 0, issues: [] }) },
        agentsMd: { list: async () => [], read: async () => ({ ok: true, content: '' }), create: async () => ({ ok: false }), write: async () => ({ ok: true }) },
        systemPermissions: { status: async () => [], open: async () => {} }
      }
    }
  })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { language: 'zh-CN' } })
}

const settings = { language: 'zh-CN', mcpServers: [] }

test('tools view is the default and does not list builtin primitives', () => {
  installWindow()
  store.patch({
    settings,
    skills: [
      { id: 'claude:demo', name: 'demo', description: 'A long skill description that stays collapsed.', origin: 'claude', path: '/claude/demo', shared: false, updatedAt: 1 },
      { id: 'codex:demo', name: 'demo', description: 'Shorter.', origin: 'codex', path: '/codex/demo', shared: false, updatedAt: 1 }
    ],
    bots: [
      { id: 'a', name: 'Developer', archived: false, tools: ['read_file', 'shell'], skills: ['claude:demo'], agentsMdIds: [], computerTarget: { kind: 'local' } },
      { id: 'b', name: 'Reviewer', archived: false, tools: ['read_file'], skills: [], agentsMdIds: [], computerTarget: { kind: 'local' } }
    ],
    session: null
  })
  const html = renderToStaticMarkup(React.createElement(SettingsTools, { settings }))
  assert.match(html, /data-tool-view="tools"/)
  assert.match(html, /工具视图/)
  assert.match(html, /Agent 视图/)
  assert.match(html, /一键同步/)
  assert.match(html, /管理每个 Agent 的技能、MCP 服务器和 AGENTS.md/)
  assert.equal(html.includes('应用只放'), false)
  assert.equal(html.includes('read_file'), false)
  assert.equal(html.includes('write_file'), false)
  assert.equal(html.includes('shell'), false)
  assert.match(html, /data-tool-section="skills"/)
  assert.equal(html.includes('data-tool-section="skills" open'), false)
  assert.match(html, /data-skill="demo"/)
  assert.match(html, /data-skill-description/)
  assert.equal(html.includes('data-skill-description" open'), false)
  assert.match(html, /AGENTS.md/)
  const agent = renderToStaticMarkup(React.createElement(SettingsTools, { settings, initialView: 'agent' }))
  assert.match(agent, /data-tool-view="agent"/)
  assert.match(agent, /选择 Agent/)
  assert.equal(agent.includes('data-skill="demo"'), false)
  assert.equal(agent.includes('read_file'), false)
  const dialog = renderToStaticMarkup(React.createElement(SettingsTools, { settings, initialSync: true }))
  assert.match(dialog, /data-sync-dialog/)
  assert.match(dialog, /基准：以一个 Agent 为来源/)
  assert.match(dialog, /合并：取所有 Agent 的并集/)
})

test('system permission rows render probe status and the Settings deep link', () => {
  const list = { hidden: [], added: ['camera'] }
  const html = renderToStaticMarkup(React.createElement(SystemPermissionList, {
    zh: true,
    list,
    statuses: { 'screen-recording': 'granted', accessibility: 'denied', microphone: 'not-determined', notifications: 'unknown', camera: 'restricted' },
    onChange() {},
    onOpen() {}
  }))
  assert.match(html, /data-system-permission="screen-recording"/)
  assert.match(html, /Privacy_ScreenCapture/)
  assert.match(html, /已授权/)
  assert.match(html, /未授权/)
  assert.match(html, /未确定/)
  assert.match(html, /未知/)
  assert.match(html, /打开系统设置/)
  assert.match(html, /data-system-permission="camera"/)
  assert.equal(html.includes('data-system-permission="full-disk-access"'), false)
  const removed = renderToStaticMarkup(React.createElement(SystemPermissionList, {
    zh: true,
    list: { hidden: ['screen-recording'], added: [] },
    statuses: { 'screen-recording': 'granted' },
    onChange() {},
    onOpen() {}
  }))
  assert.equal(removed.includes('data-system-permission="screen-recording"'), false)
  assert.equal(removed.includes('已授权'), false)
})
