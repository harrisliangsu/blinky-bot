/** Platform-independent fallback policy; native handles never leave the main process. */
export interface GlassBridge { status(): { supported: boolean; reduced: boolean }; update(handle: Buffer, width: number, enabled: boolean, dark: boolean): boolean }
export interface ChromeStatus { supported: boolean; applied: boolean; reduced: boolean }
export function updateGlassSurface(bridge: GlassBridge | null, handle: Buffer, width: number, enabled: boolean, dark: boolean, reduced = false): ChromeStatus {
  let status = { supported: false, reduced }
  try {
    const native = bridge?.status()
    if (native) status = { supported: native.supported, reduced: reduced || native.reduced }
    if (bridge && status.supported && !status.reduced && enabled && width > 0 && bridge.update(handle, width, true, dark)) return { ...status, applied: true }
  } catch { /* Native bridge failures retain the readable opaque interface. */ }
  try { bridge?.update(handle, 0, false, dark) } catch { /* removal failure must not crash the UI */ }
  return { ...status, applied: false }
}
