// Test-only transparent CLI relay. Persist only model/effort, request ids and
// synthetic QA markers. Never persist MCP config, headers, account or auth data.
const { spawn } = require('node:child_process')
const { createInterface } = require('node:readline')
const { appendFileSync } = require('node:fs')
const backend = process.env.BLINKY_QA_BACKEND
const trace = process.env.BLINKY_QA_TRACE
const args = process.argv.slice(2)
const record = (row) => appendFileSync(trace, JSON.stringify({ pid: process.pid, at: Date.now(), ...row }) + '\n')
const chosen = args.indexOf('--model')
record({ direction: 'spawn', backend, model: chosen < 0 ? null : args[chosen + 1] })
const child = spawn(process.env.BLINKY_QA_REAL_CLI, args, { stdio: ['pipe', 'pipe', 'pipe'] })
const methods = new Map()
const markers = (value) => [...new Set((JSON.stringify(value).match(/QA_[A-Z0-9_]+/g) || []))]
createInterface({ input: process.stdin }).on('line', (line) => {
  try {
    const m = JSON.parse(line), p = m.params || {}
    if (m.method) methods.set(String(m.id), m.method)
    if (['thread/start', 'thread/resume', 'turn/start', 'session/new', 'session/load', 'session/prompt', 'session/set_config_option'].includes(m.method)) {
      record({ direction: 'request', method: m.method, id: m.id, model: p.model ?? null, effort: p.effort ?? null, threadId: p.threadId, sessionId: p.sessionId, configId: p.configId, value: ['model', 'thinking', 'reasoning_effort', 'mode'].includes(p.configId) ? p.value : undefined, markers: markers(p.input || p.prompt || []) })
    }
  } catch { /* stdin text/stream-json for print transports is relayed unchanged */ }
  child.stdin.write(line + '\n')
}).on('close', () => child.stdin.end())
createInterface({ input: child.stdout }).on('line', (line) => {
  try {
    const m = JSON.parse(line), method = methods.get(String(m.id)), r = m.result
    if (r && ['thread/start', 'thread/resume', 'turn/start', 'session/new', 'session/load', 'session/set_config_option'].includes(method)) {
      record({ direction: 'response', method, id: m.id, model: r.model, effort: r.reasoningEffort, threadId: r.thread?.id, sessionId: r.sessionId, options: r.configOptions?.filter(o => ['model', 'thinking', 'reasoning_effort', 'mode'].includes(o.id)).map(o => ({ id: o.id, value: o.currentValue })) })
    }
    if (m.type === 'system' && m.model) record({ direction: 'model', model: m.model })
    if (m.type === 'result' && m.modelUsage) record({ direction: 'model', models: Object.keys(m.modelUsage) })
    if (m.message?.model) record({ direction: 'model', model: m.message.model })
  } catch { /* diagnostics are not recorded */ }
  process.stdout.write(line + '\n')
})
child.stderr.on('data', data => process.stderr.write(data))
process.on('SIGTERM', () => child.kill('SIGTERM'))
process.on('SIGINT', () => child.kill('SIGINT'))
child.on('error', () => process.exit(1))
child.on('exit', (code) => process.exit(code ?? 1))
