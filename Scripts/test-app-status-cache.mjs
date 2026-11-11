// Isolated, hidden Electron renderer test: no real accounts or desktop input.
import { build } from 'esbuild'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const repo = process.cwd()
const root = await mkdtemp(path.join(tmpdir(), 'blinky-app-status-'))
try {
  await build({ stdin: { resolveDir: repo, loader: 'tsx', contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {SettingsApps} from './src/renderer/src/components/SettingsApps';
    import {store} from './src/renderer/src/state';
    store.patch({settings: {language:'zh-CN'}, bots: []} as any);
    const pending: any[] = [];
    (window as any).testPending = pending;
    (window as any).openbot = {apps: {
      status: () => new Promise((resolve, reject) => pending.push({resolve, reject})),
      slackStatus: () => Promise.resolve({state:'disconnected'}),
      cancelGoogle: () => Promise.resolve(), cancelX: () => Promise.resolve()
    }};
    const root = createRoot(document.getElementById('app')!);
    (window as any).mount = () => root.render(<SettingsApps />);
    (window as any).unmount = () => root.render(null);
    (window as any).mount();
  ` }, bundle: true, format: 'iife', platform: 'browser', loader: { '.css': 'empty' }, outfile: path.join(root, 'app.js'), logLevel: 'silent' })
  await writeFile(path.join(root, 'index.html'), '<div id="app"></div><script src="app.js"></script>')
  await writeFile(path.join(root, 'runner.cjs'), `
    const {app, BrowserWindow} = require('electron');
    const path = require('path');
    const root = process.argv[2], phase = process.argv[3];
    app.setPath('userData', path.join(root, 'profile'));
    if (process.platform === 'darwin') app.dock.hide();
    app.whenReady().then(async () => {
      const win = new BrowserWindow({show:false, webPreferences:{contextIsolation:false, nodeIntegration:false}});
      await win.loadFile(path.join(root, 'index.html'));
      const result = await win.webContents.executeJavaScript(\`(async () => {
        const delay = () => new Promise(r => setTimeout(r, 80));
        const assert = (yes, message) => { if (!yes) throw new Error(message); };
        const text = id => document.querySelector('[data-app="'+id+'"] .ob-set-value')?.textContent || '';
        for (let i=0; i<100 && !window.testPending.length; i++) await delay();
        assert(!document.querySelector('[data-apps]').textContent.includes('正在检查'), 'checking state visible');
        if (\${JSON.stringify(phase)} === 'first') {
          assert(text('github').includes('状态未知'), 'first launch must show unknown');
          window.testPending.shift().resolve([
            {id:'github',status:'connected',account:'private-account'}, {id:'git',status:'disconnected'},
            {id:'gmail',status:'connected'}, {id:'calendar',status:'disconnected'},
            {id:'slack',status:'disconnected'}, {id:'x',status:'disconnected'}]);
          await delay(); assert(text('github').includes('已连接'), 'fresh status missing');
          assert(!document.querySelector('[data-app="git"]') && !document.querySelector('[data-app="calendar"]') && !document.querySelector('[data-app="slack"]'), 'hidden apps are not in the grid');
          assert(!localStorage.getItem('blinky.apps.last-known.v1').includes('private-account'), 'account leaked into cache');
          window.unmount(); await delay(); window.mount(); await delay();
          assert(text('github').includes('已连接') && !text('github').includes('上次'), 'reopen did not reuse the recent status');
          assert(window.testPending.length === 0, 'reopen unnecessarily repeated the check');
          assert(!document.querySelector('.ob-apps-search') && !document.querySelector('.ob-apps-intro button'), 'list chrome was removed');
        } else {
          assert(text('github').includes('上次：已连接'), 'restart did not restore last known status');
          window.testPending.shift().resolve([
            {id:'github',status:'disconnected'}, {id:'git',status:'disconnected'},
            {id:'gmail',status:'unavailable',detail:'verification-failed'}, {id:'calendar',status:'disconnected'},
            {id:'slack',status:'disconnected'}, {id:'x',status:'disconnected'}]);
          await delay(); assert(text('github').includes('未连接') && !text('github').includes('上次'), 'fresh revocation not reflected');
          assert(!document.querySelector('[data-app="git"]') && !document.querySelector('[data-app="calendar"]') && !document.querySelector('[data-app="slack"]'), 'hidden apps are not in the grid');
          assert(text('gmail').includes('不可用'), 'verification failure hidden');
        }
        return 'ok';
      })()\`, true);
      await win.webContents.session.flushStorageData(); win.destroy(); console.log(phase + ': ' + result); app.quit();
    }).catch(error => { console.error(error); app.exit(1); });
  `)
  const electron = path.join(repo, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  for (const phase of ['first', 'restart']) {
    const child = spawnSync(electron, [path.join(root, 'runner.cjs'), root, phase], { encoding: 'utf8', timeout: 30000, env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' } })
    if (child.status !== 0) throw new Error(`${phase}: status=${child.status} signal=${child.signal} ${child.error || child.stderr || child.stdout}`)
    process.stdout.write(child.stdout)
  }
} finally { await rm(root, {recursive: true, force: true}) }
