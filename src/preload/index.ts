/** Electron-specific transport; every API method is shared with the browser client. */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { createOpenBotApi } from '../shared/apiClient'
const MENU_CHANNEL = 'openbot:menu'
const api = createOpenBotApi({
  invoke: <T>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args) as Promise<T>,
  subscribe: <T>(channel: string, listener: (payload: T) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  }
})
contextBridge.exposeInMainWorld('openbot', api)

/**
 * Native-menu commands reach the renderer as DOM events rather than as extra
 * bridge surface: `openbot:menu:new-chat` and `openbot:menu:settings` fire on
 * `window`, and the same command also arrives as a `postMessage` payload
 * `{ source: 'openbot', type: 'menu', command }` for listeners that prefer it.
 */
ipcRenderer.on(MENU_CHANNEL, (_event: IpcRendererEvent, command: unknown) => {
  if (typeof command !== 'string') return
  try {
    window.dispatchEvent(new Event(`openbot:menu:${command}`))
    window.postMessage({ source: 'openbot', type: 'menu', command }, '*')
  } catch (err) {
    console.error('[openbot] could not deliver menu command', err)
  }
})
