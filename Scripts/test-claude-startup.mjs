// Read-only diagnostics. No model request, login, refresh or credential writes.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const binary = process.argv[2] ?? '/opt/homebrew/bin/claude'
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'blinky-claude-startup-'))
async function observe(command, args, options = {}) {
  const start = Date.now(), child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
  let stdout = '', stderr = '', error
  child.stdout?.on('data', c => { stdout += c })
  child.stderr?.on('data', c => { stderr += c })
  child.on('error', e => { error = e.code ?? e.name })
  const timer = setTimeout(() => child.kill('SIGTERM'), 10000)
  const [code, signal] = await new Promise(resolve => child.once('close', (code, signal) => resolve([code, signal])))
  clearTimeout(timer)
  return { code, signal, elapsedMs: Date.now() - start, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr), ...(error ? { error } : {}), stdout }
}
const safe = ({ stdout, ...metadata }) => metadata
const samples = []
for (const detached of [false, true]) {
  for (let i = 0; i < 2; i++) samples.push({ parent: 'node', detached, ...safe(await observe(binary, ['--version'], { detached })) })
}
const minimal = Object.fromEntries(['HOME', 'USER', 'LOGNAME', 'PATH', 'TMPDIR', 'SHELL'].filter(k => process.env[k]).map(k => [k, process.env[k]]))
samples.push({ parent: 'node', env: 'minimal', ...safe(await observe(binary, ['--version'], { env: minimal })) })
// The reference reads auth status and emits only a boolean; it cannot call a model.
const reference = await observe('/usr/bin/python3', ['-c', `
import subprocess,json,sys,time
rows=[]
for args in [['--version'],['auth','status']]:
 start=time.monotonic()
 p=subprocess.run([sys.argv[1]]+args,stdin=subprocess.DEVNULL,capture_output=True,text=True,timeout=8)
 row={'parent':'python','probe':'version' if len(args)==1 else 'auth-status','returnCode':p.returncode,'elapsedMs':round((time.monotonic()-start)*1000),'stdoutBytes':len(p.stdout.encode()),'stderrBytes':len(p.stderr.encode())}
 if len(args)>1:
  try:row['loggedIn']=json.loads(p.stdout).get('loggedIn') is True
  except:row['loggedIn']=None
 rows.append(row)
print(json.dumps(rows))
`, binary])
let python = []
try { python = JSON.parse(reference.stdout) } catch { /* only safe parent metadata below */ }
const signature = await observe('/usr/bin/codesign', ['--verify', '--strict', await fs.realpath(binary)])
const result = { root, binary: await fs.realpath(binary), nodeVersion: process.version, arch: process.arch, samples, python, pythonParent: safe(reference), signature: safe(signature), noModelRequests: true }
await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
