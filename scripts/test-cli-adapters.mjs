import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const dir = await mkdtemp(join(tmpdir(), 'blinkybot-cli-test-'))
const outfile = join(dir, 'kimi-grok.test.mjs')

await build({
  entryPoints: ['src/main/backends/cli/kimi-grok.test.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  external: ['electron']
})

const child = spawn(process.execPath, ['--test', outfile], { stdio: 'inherit' })
const code = await new Promise((resolve) => child.on('exit', resolve))
await rm(dir, { recursive: true, force: true })
process.exit(code ?? 1)
