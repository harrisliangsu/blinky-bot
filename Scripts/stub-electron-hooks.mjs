const STUB = new URL('data:text/javascript,' + encodeURIComponent(`
export const app = { getPath: () => process.env.OPENBOT_DATA_DIR || process.cwd(), getVersion: () => '0.0.0-probe', getName: () => 'openbot-probe', getLocale: () => 'zh-CN', isReady: () => true, on: () => {}, whenReady: () => Promise.resolve(), setAppUserModelId: () => {}, dock: { hide: () => {}, show: () => {}, setBadgeCount: () => {} }, isPackaged: false }
export const nativeTheme = { themeSource: 'system', on: () => {} }
export const safeStorage = { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('stub') }, decryptString: () => { throw new Error('stub') } }
export const clipboard = { readText: () => '', writeText: () => {} }
export const shell = { openExternal: async () => {}, showItemInFolder: () => {} }
export const Notification = class { static isSupported() { return false } constructor() {} show() {} on() {} }
export const BrowserWindow = class { static getAllWindows() { return [] } constructor() {} }
export const ipcMain = { on: () => {}, handle: () => {} }
export const screen = { getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 } }) }
export const systemPreferences = { askForMediaAccess: async () => 'denied', on: () => {} }
export const powerMonitor = { on: () => {} }
export const Menu = { setApplicationMenu: () => {}, buildFromTemplate: () => ({}) }
export const globalShortcut = { register: () => false, unregisterAll: () => {} }
export const net = { fetch: globalThis.fetch }
export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }
export default { app, nativeTheme, safeStorage, clipboard, shell, Notification, BrowserWindow, ipcMain, screen, systemPreferences, powerMonitor, Menu, globalShortcut, net, dialog }
`))

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') return { url: STUB.href, shortCircuit: true }
  return nextResolve(specifier, context)
}
