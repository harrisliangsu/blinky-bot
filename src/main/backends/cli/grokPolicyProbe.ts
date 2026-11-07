/** Verify the native Grok session's actual permission mode before prompting. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function shellQuote(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'` }

export interface GrokPolicyProbe {
  pluginDir: string
  markerPath: string
  verify(sessionId: string): Promise<void>
  cleanup(): Promise<void>
}

export async function createGrokPolicyProbe(): Promise<GrokPolicyProbe> {
  const root = await mkdtemp(join(tmpdir(), 'blinky-grok-policy-'))
  const pluginDir = join(root, 'plugin'), markerPath = join(root, 'mode.json'), helper = join(root, 'report.cjs')
  try {
    await mkdir(join(pluginDir, 'hooks'), { recursive: true, mode: 0o700 })
    // Only non-secret mode and session id are recorded. The hook never makes
    // an approval decision and does not alter the user's global Grok config.
    await writeFile(helper, `const fs=require('node:fs');let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>{if(data.length<65536)data+=x}).on('end',()=>{try{const e=JSON.parse(data),file=process.env.BLINKY_GROK_POLICY_MARKER,tmp=file+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify({event:e.hookEventName,mode:e.permissionMode,sessionId:e.sessionId}),{mode:0o600});fs.renameSync(tmp,file)}catch{process.exitCode=1}});\n`, { mode: 0o600 })
    const command = `ELECTRON_RUN_AS_NODE=1 ${shellQuote(process.execPath)} ${shellQuote(helper)}`
    await writeFile(join(pluginDir, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command, timeout: 5 }] }] } }), { mode: 0o600 })
    return {
      pluginDir,
      markerPath,
      async verify(sessionId) {
        const deadline = Date.now() + 4000
        while (Date.now() < deadline) {
          try {
            const value = JSON.parse(await readFile(markerPath, 'utf8')) as { event?: unknown; mode?: unknown; sessionId?: unknown }
            if (value.event !== 'session_start' || value.sessionId !== sessionId || value.mode !== 'default') throw new Error('Grok did not confirm its normal permission mode; the turn was not started.')
            return
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        throw new Error('Grok did not report its permission mode; the turn was not started.')
      },
      cleanup: async () => { await rm(root, { recursive: true, force: true }) }
    }
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error }
}
