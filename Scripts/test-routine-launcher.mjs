/** Registers and removes only a unique temporary launchd service. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { reconcileRoutineJob } from '../src/main/app/routineLaunchJob.ts'

if(process.platform!=='darwin')throw Error('macOS required')
const run=promisify(execFile), root=await fs.mkdtemp(path.join(os.tmpdir(),'blinky-launcher-')),label='bot.blinky.test.'+randomUUID().replaceAll('-','')
const plistPath=path.join(root,'job.plist'),markerPath=path.join(root,'owner.json'),service=`gui/${process.getuid()}/${label}`
const bundle=path.join(root,'Runner & Test.app'),contents=path.join(bundle,'Contents'),executable=path.join(contents,'MacOS','runner'),started=path.join(root,'started'),finished=path.join(root,'finished')
await fs.mkdir(path.dirname(executable),{recursive:true})
await fs.writeFile(path.join(contents,'Info.plist'),`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${label}</string><key>CFBundleExecutable</key><string>runner</string><key>CFBundleName</key><string>Blinky Test Runner</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`)
await fs.writeFile(executable,`#!/bin/sh\nprintf start > '${started}'\nsleep 4\nprintf done > '${finished}'\n`);await fs.chmod(executable,0o700)
const options={label,plistPath,markerPath,bundle,enabled:true,uid:process.getuid()}
try {
 await fs.writeFile(plistPath,'unmanaged')
 await assert.rejects(reconcileRoutineJob(options),/different background task/)
 assert.equal(await fs.readFile(plistPath,'utf8'),'unmanaged')
 await fs.unlink(plistPath)
 assert.equal((await reconcileRoutineJob(options)).state,'active')
 const original=await fs.readFile(plistPath,'utf8'),parsed=JSON.parse((await run('/usr/bin/plutil',['-convert','json','-o','-',plistPath])).stdout)
 assert.deepEqual(parsed.ProgramArguments,['/usr/bin/open','-n','-g','-j','-a',options.bundle,'--args','--routine-runner'])
 assert.equal(parsed.StartInterval,60)
 assert.equal((await reconcileRoutineJob(options)).state,'active')
 await fs.writeFile(plistPath,'user modified')
 await assert.rejects(reconcileRoutineJob({...options,enabled:false}),/different background task/)
 assert.equal(await fs.readFile(plistPath,'utf8'),'user modified')
 await fs.writeFile(plistPath,original)
 await run('/bin/launchctl',['kickstart',service])
 for(let i=0;i<100&&!(await fs.stat(started).then(()=>true,()=>false));i++)await new Promise(r=>setTimeout(r,100))
 assert.equal(await fs.stat(started).then(()=>true,()=>false),true,'launchd did not launch test app')
 assert.equal((await reconcileRoutineJob({...options,enabled:false})).state,'inactive')
 for(let i=0;i<70&&!(await fs.stat(finished).then(()=>true,()=>false));i++)await new Promise(r=>setTimeout(r,100))
 assert.equal(await fs.stat(finished).then(()=>true,()=>false),true,'unregistering killed the app it launched')
 assert.equal(await fs.stat(plistPath).then(()=>true,()=>false),false)
 assert.equal(await fs.stat(markerPath).then(()=>true,()=>false),false)
 console.log(JSON.stringify({registered:true,validPlist:true,unmanagedPreserved:true,modifiedPreserved:true,appSurvivesUnregister:true,unregistered:true}))
}finally{
 await run('/bin/launchctl',['bootout',service]).catch(()=>undefined)
 await fs.rm(root,{recursive:true,force:true})
}
