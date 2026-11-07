import {test} from 'node:test'

// Native startup can abort before any JavaScript handler exists and show an OS
// crash dialog. This test stays suspended; do not enable it on the user's Mac.
test('fresh processes use persisted connections in Bot tools, show permission errors and remain disconnected', {skip:'Suspended: native Electron may show desktop dialogs; requires an isolated CI/VM session.',timeout:30000}, async()=>{
 // Even app/store imports belong inside the suspended callback. Running this
 // file directly must not load production modules or touch the real profile.
 const {default:assert}=await import('node:assert/strict')
 const {spawnSync}=await import('node:child_process')
 const {mkdtemp,writeFile,rm,symlink}=await import('node:fs/promises')
 const {tmpdir}=await import('node:os'),{join}=await import('node:path')
 const {build}=await import('electron-vite')
 const {connectionTestEnvironment}=await import('./testEnvironment.mjs')
 const {createBot}=await import('../store/bots.ts')
 const {createSession,loadSessions}=await import('../store/sessions.ts')
 const {flushAll}=await import('../store/jsonStore.ts')
 const {saveGoogleCredentials,setGoogleStorageForTests}=await import('./googleSecrets.ts')
 const {saveXCredentials,setXStorageForTests}=await import('./xSecrets.ts')
 const {saveSlackCredentials,setSlackStorageForTests}=await import('./slackSecrets.ts')
 const {SLACK_USER_SCOPES}=await import('./slackOAuth.ts')
 const root=await mkdtemp(join(tmpdir(),'blinky-restart-tools-')),old=process.env.OPENBOT_DATA_DIR
 const env=await connectionTestEnvironment(root);process.env.OPENBOT_DATA_DIR=env.OPENBOT_DATA_DIR
 const storage={isEncryptionAvailable:()=>true,encryptString:v=>Buffer.from([...v].reverse().join('')),decryptString:v=>[...v.toString()].reverse().join('')}
 setGoogleStorageForTests(storage);setXStorageForTests(storage);setSlackStorageForTests(storage)
 try{
 await loadSessions()
 const bot=createBot({name:'Fixture',backendId:'codex',modelId:'fixture',followsDefault:false}),session=createSession([bot.id])
 await flushAll();await writeFile(join(env.OPENBOT_DATA_DIR,'test-context.json'),JSON.stringify({botId:bot.id,sessionId:session.id}))
 // Fake gh is installed before any app-status module runs. It cannot do network I/O.
 await writeFile(join(root,'bin','gh'),'#!/bin/sh\nprintf "not logged into any github hosts\\n" >&2\nexit 1\n',{mode:0o700})
 const base={clientId:'123456789-fixture.apps.googleusercontent.com',account:'fixture@example.test'}
 await saveGoogleCredentials('gmail',{...base,refreshToken:'gmail-refresh',scopes:['openid','email','https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send']})
 await saveGoogleCredentials('calendar',{...base,refreshToken:'calendar-refresh',scopes:['openid','email','https://www.googleapis.com/auth/calendar.events']})
 await saveXCredentials({clientId:'fixture-native-x-client',refreshToken:'x-refresh',userId:'123',username:'fixture'})
 await saveSlackCredentials({appToken:'',botToken:'xoxe.xoxp-fixture-access',teamId:'T123',botUserId:'U123',allowedUserId:'U123',channelId:'C123',botId:bot.id,oauth:{clientId:'123456.789012',scopes:SLACK_USER_SCOPES,refreshToken:'fixture-refresh',expiresAt:1}})
 await symlink(join(process.cwd(),'node_modules'),join(root,'node_modules'),'dir')
 const configFile=join(root,'electron.config.mjs')
 await writeFile(configFile,`export default {main:{envDir:${JSON.stringify(root)},build:{outDir:${JSON.stringify(join(root,'out'))},lib:{entry:${JSON.stringify(join(process.cwd(),'src/main/connectors/restartProbe.mjs'))},formats:['es']},rollupOptions:{output:{entryFileNames:'probe.mjs'}}}}}`)
 await build({configFile,envFile:false,logLevel:'error'})
 const launcher=join(root,'launch.cjs')
 await writeFile(launcher,"let app;const fail=e=>{console.error(e);if(app)app.exit(1);else process.exit(1)};process.on('uncaughtException',fail);process.on('unhandledRejection',fail);({app}=require('electron'));app.setPath('userData',process.env.OPENBOT_DATA_DIR);app.whenReady().then(()=>import('./out/probe.mjs')).catch(fail);\n")
 const electron=join(process.cwd(),'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
 for(const phase of ['tools','send-denied','denied','disconnect','disconnected']){
 const child=spawnSync(electron,[launcher,phase],{cwd:process.cwd(),env,encoding:'utf8',timeout:15000})
 assert.ifError(child.error)
 assert.equal(child.status,0,`${phase}: ${child.error??''}\n${child.stdout}\n${child.stderr}`);process.stdout.write(child.stdout)
 }
 }finally{await flushAll();if(old===undefined)delete process.env.OPENBOT_DATA_DIR;else process.env.OPENBOT_DATA_DIR=old;await rm(root,{recursive:true,force:true})}
})
