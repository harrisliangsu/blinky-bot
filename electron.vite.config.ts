import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

/** Localhost sources the dev server needs in the CSP and a build must not keep. */
const DEV_CSP_SOURCES = /\s+(?:wss?|https?):\/\/localhost:\*/g

/**
 * Strip the dev-server allowances out of the renderer's CSP at build time.
 *
 * `src/renderer/index.html` has to permit `ws://localhost:*` and
 * `http://localhost:*` in `connect-src` for Vite's HMR socket, but shipping
 * that allowance lets a packaged renderer reach anything listening on
 * localhost — every backend, gateway and CLI server the machine happens to be
 * running. Nothing in the app needs it: all traffic goes over IPC. The build
 * therefore removes them, and fails loudly if any localhost source survives,
 * so a future edit to the HTML cannot quietly put one back.
 */
function stripDevCsp(): Plugin {
  return {
    name: 'openbot-strip-dev-csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html: string): string {
        const stripped = html.replace(DEV_CSP_SOURCES, '')
        if (stripped.includes('localhost')) {
          throw new Error('renderer HTML still references localhost after CSP stripping')
        }
        return stripped
      }
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          vmDaemon: resolve('src/main/vmDaemon.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        // CommonJS, not the ESM this package otherwise uses: Electron only
        // loads an ESM preload when the renderer sandbox is off, and the
        // sandbox is the guarantee worth keeping. `.cjs` because `package.json`
        // declares `"type": "module"`, so a bare `.js` would be read as ESM.
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: { alias: { '@': resolve('src/renderer/src') } },
    plugins: [react(), stripDevCsp()],
    build: { rollupOptions: { input: { index: resolve('src/renderer/index.html'), remote: resolve('src/renderer/remote.html') } } }
  }
})
