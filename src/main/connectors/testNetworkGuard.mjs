import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { promisify } from 'node:util'

// Test-only fail-closed protection, installed before any test module imports.
// Native GUI aborts cannot be caught in JS, so never start the GUI process.
function rejectDesktop(args) {
  const values = args.filter((arg) => typeof arg === 'string')
  for (const arg of args) {
    if (Array.isArray(arg)) values.push(...arg.filter((v) => typeof v === 'string'))
    else if (arg && typeof arg === 'object' && typeof arg.execPath === 'string') values.push(arg.execPath)
  }
  if (values.some((value) => /(?:\.app[\\/]Contents[\\/]MacOS[\\/]|(?:^|[\\/\s])(?:electron(?:\.exe)?|open|osascript)(?:$|[\s]))/i.test(value))) {
    throw new Error('DESKTOP_TEST_DISABLED: no Electron or desktop launcher may run in this connector test suite.')
  }
}
function guarded(fn) {
  function call(...args) { rejectDesktop(args); return Reflect.apply(fn, this, args) }
  const custom = fn[promisify.custom]
  if (typeof custom === 'function') Object.defineProperty(call, promisify.custom, {
    value: function (...args) { rejectDesktop(args); return Reflect.apply(custom, this, args) }
  })
  return call
}
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[name] = guarded(childProcess[name])
syncBuiltinESMExports()

// OAuth unit tests use injected transports. Only their loopback callback is a
// real HTTP request; an accidental unmocked provider request fails locally.
const realFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('Connector test refused a non-loopback network request.')
  return realFetch(input, init)
}
