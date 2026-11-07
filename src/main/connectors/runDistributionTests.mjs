// Narrow Node-only browser-entry/error-callback/tool-path suite.
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectionTestEnvironment } from './testEnvironment.mjs'
if (process.versions.electron) throw Error('Native desktop tests remain suspended.')
const only=process.argv[2]
if(process.argv.length>3 || (only && !['--gateway-only','--x-only','--ui-only'].includes(only)))throw Error('Use --gateway-only, --x-only or --ui-only.')
const selected = only==='--gateway-only' ? ['src/main/connectors/connectedToolsGateway.test.mjs'] : only==='--x-only' ? ['src/main/connectors/xOAuth.test.ts'] : only==='--ui-only' ? ['src/renderer/src/components/ConnectCards.browserLogin.test.mjs'] : ['src/renderer/src/components/ConnectCards.browserLogin.test.mjs','src/main/connectors/xOAuth.test.ts','src/main/connectors/connectedToolsGateway.test.mjs']
const root=await mkdtemp(join(tmpdir(),'blinky-distribution-suite-'))
try {
  const child=spawnSync(process.execPath,['--experimental-transform-types','--import','./scripts/register-ts.mjs','--import','./src/main/connectors/testNetworkGuard.mjs','--test','--test-concurrency=1','--test-timeout=30000',
    ...selected
  ],{cwd:process.cwd(),env:await connectionTestEnvironment(root),stdio:'inherit',timeout:90000})
  if(child.error)throw child.error
  process.exitCode=child.status??1
}finally{await rm(root,{recursive:true,force:true})}
