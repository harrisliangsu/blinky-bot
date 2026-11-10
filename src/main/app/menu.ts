/**
 * The native application menu.
 *
 * Standard roles do the heavy lifting; the two OpenBOT-specific items push a
 * command to the renderer, which owns what "New Chat" and "Settings" mean.
 */

import { Menu, app, type MenuItemConstructorOptions } from 'electron'
import { sendMenuCommand } from '../ipc'
import { runUpdateCheck } from '../updates/service'

const isMac = process.platform === 'darwin'

const settingsItem: MenuItemConstructorOptions = {
  label: isMac ? 'Settings…' : 'Preferences…',
  accelerator: 'CmdOrCtrl+,',
  click: () => sendMenuCommand('settings')
}

function appMenu(): MenuItemConstructorOptions[] {
  if (!isMac) return []
  return [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        settingsItem,
        { label: 'Check for Updates…', click: () => void runUpdateCheck('manual') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }
  ]
}

function fileMenu(): MenuItemConstructorOptions {
  const items: MenuItemConstructorOptions[] = [
    { label: 'Focus Message', accelerator: 'CmdOrCtrl+L', click: () => sendMenuCommand('focus-composer') },
    { label: 'Find Bot', accelerator: 'CmdOrCtrl+F', click: () => sendMenuCommand('find-bot') },
    { type: 'separator' }
  ]
  if (isMac) {
    items.push({ role: 'close' })
  } else {
    items.push(settingsItem, { type: 'separator' }, { role: 'quit' })
  }
  return { label: 'File', submenu: items }
}

function editMenu(): MenuItemConstructorOptions {
  const items: MenuItemConstructorOptions[] = [
    { role: 'undo' },
    { role: 'redo' },
    { type: 'separator' },
    { role: 'cut' },
    { role: 'copy' },
    { role: 'paste' }
  ]
  if (isMac) {
    items.push(
      { role: 'pasteAndMatchStyle' },
      { role: 'delete' },
      { role: 'selectAll' },
      { type: 'separator' },
      { label: 'Speech', submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }] }
    )
  } else {
    items.push({ role: 'delete' }, { type: 'separator' }, { role: 'selectAll' })
  }
  return { label: 'Edit', submenu: items }
}

const viewMenu: MenuItemConstructorOptions = {
  label: 'View',
  submenu: [
    { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+\\', click: () => sendMenuCommand('toggle-sidebar') },
    { type: 'separator' },
    { role: 'reload' },
    { role: 'forceReload' },
    { role: 'toggleDevTools' },
    { type: 'separator' },
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' }
  ]
}

function windowMenu(): MenuItemConstructorOptions {
  const items: MenuItemConstructorOptions[] = [{ role: 'minimize' }, { role: 'zoom' }]
  if (isMac) {
    items.push({ type: 'separator' }, { role: 'front' }, { type: 'separator' }, { role: 'window' })
  } else {
    items.push({ role: 'close' })
  }
  return { label: 'Window', submenu: items }
}

/** Build and install the application menu. */
export function installMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...appMenu(),
    fileMenu(),
    editMenu(),
    viewMenu,
    windowMenu()
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
