// Transparent native transport, metadata-only diagnostic log (never credentials).
const cp = require('node:child_process')
const fs = require('node:fs')
const args = process.argv.slice(2)
const options = globalThis.__planningNative
if (options.controlled || args[0] === 'app-server' && process.cwd() !== options.leadCwd) {
  require(options.fixture)
} else {
  fs.appendFileSync(options.trace, JSON.stringify({ at: Date.now(), pid: process.pid, direction: 'metadata', method: 'native-launch', systemCaEnabled: process.env.NODE_USE_SYSTEM_CA === '1', tlsVerificationDisabled: process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' }) + '\n')
  const child = cp.spawn(options.binary, args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
  const partial = { input: '', output: '' }
  const observe = (direction, bytes) => {
    partial[direction] += bytes
    for (;;) {
      const end = partial[direction].indexOf('\n'); if (end < 0) break
      const line = partial[direction].slice(0, end); partial[direction] = partial[direction].slice(end + 1)
      try {
        const packet = JSON.parse(line)
        if (!packet.jsonrpc && !packet.method && packet.id === undefined) continue
        fs.appendFileSync(options.trace, JSON.stringify({ at: Date.now(), pid: child.pid, direction, method: packet.method, id: packet.id, errorCode: packet.error?.code, resultKeys: packet.result ? Object.keys(packet.result) : undefined, stopReason: packet.result?.stopReason, model: packet.result?.configOptions?.find(option => option.id === 'model')?.currentValue, ...(packet.method === 'session/update' ? { updateType: packet.params?.update?.sessionUpdate } : {}), ...(packet.method === 'session/set_config_option' ? { configId: packet.params?.configId, value: packet.params?.value } : {}) }) + '\n')
      } catch {}
    }
  }
  process.stdin.on('data', bytes => { observe('input', bytes); child.stdin.write(bytes) })
  process.stdin.on('end', () => child.stdin.end())
  child.stdout.on('data', bytes => { observe('output', bytes); process.stdout.write(bytes) })
  child.stderr.pipe(process.stderr)
  child.on('error', () => process.exit(1))
  child.on('exit', code => process.exit(code ?? 1))
}
