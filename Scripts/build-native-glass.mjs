/** Compile a small optional N-API/AppKit bridge; unsupported toolchains keep the opaque fallback. */
import fs from 'node:fs/promises'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
if (process.platform !== 'darwin') process.exit(0)
const destination=path.resolve('out/native/BlinkyGlass.node')
const candidates=[process.env.BLINKY_NODE_HEADERS, '/opt/homebrew/include/node', '/usr/local/include/node'].filter(Boolean)
let headers
for(const candidate of candidates)try{await fs.access(path.join(candidate,'node_api.h'));headers=candidate;break}catch{}
if(!headers){await fs.rm(destination,{force:true});console.log('[native-glass] Node headers unavailable; using opaque fallback.');process.exit(0)}
await fs.mkdir(path.dirname(destination),{recursive:true})
const result=spawnSync('xcrun',['clang++','-x','objective-c++','-std=c++17','-fobjc-arc','-shared','-undefined','dynamic_lookup','-mmacosx-version-min=14.0','-Wno-unguarded-availability-new','-framework','AppKit','-I'+headers,'src/native/BlinkyGlass.mm','-o',destination],{encoding:'utf8',timeout:30000})
if(result.status!==0){await fs.rm(destination,{force:true});console.warn('[native-glass] Optional bridge unavailable; using opaque fallback.\n'+result.stderr.slice(-1800))}
else console.log('[native-glass] Compiled AppKit NSGlassEffectView bridge.')
