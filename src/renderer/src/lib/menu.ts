/**
 * Native menu commands. The main process routes them through the preload,
 * which re-emits them as bare window events — we listen to that channel only,
 * so a command never fires twice.
 */

export const MENU_COMMANDS = ['new-chat', 'archive-clear', 'settings', 'focus-composer', 'find-bot', 'toggle-sidebar'] as const

export type MenuCommand = (typeof MENU_COMMANDS)[number]

export function onMenuCommand(handler: (command: MenuCommand) => void): () => void {
  const detach = MENU_COMMANDS.map((command) => {
    const listener = (): void => handler(command)
    const name = `openbot:menu:${command}`
    window.addEventListener(name, listener)
    return () => window.removeEventListener(name, listener)
  })
  return () => {
    for (const off of detach) off()
  }
}
