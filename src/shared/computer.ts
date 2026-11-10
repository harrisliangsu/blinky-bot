/**
 * Where a bot's GUI interaction happens.
 *
 * A bot may drive this host directly, or its own virtual machine holding
 * persistent logged-in app/browser sessions. Both satisfy `ComputerProvider`,
 * so the tool layer never contains target-specific logic.
 *
 * A VM target is also an execution boundary. Callers must never treat it as a
 * screen-only preference and then run the bot's code on the host.
 */

export type ComputerTarget =
  /** This host, driven directly. */
  | { kind: 'local' }
  /**
   * A dedicated browser instance with a persistent profile. Lighter than a
   * VM (~250MB, seconds to start) and enough for anything web-based: the
   * user signs the bot in once, and the profile keeps it signed in.
   */
  | { kind: 'browser'; botId: string; provider?: 'ego' | 'chrome' }
  | {
      kind: 'vm'
      /** Opaque id owned by the VM supervisor. */
      vmId: string
      /** Base URL of the VM's control daemon, loopback-only. */
      endpoint: string
      /** Bearer token for the control daemon; minted per-VM, stays local. */
      token?: string
      /** Renderer-safe indication that a token exists in the OS secret store. */
      hasToken?: boolean
      /** Last capabilities verified through `/health`; stale values only fail remote calls. */
      capabilities?: string[]
      /** The desktop owns this target and may start, stop, and destroy it. */
      managed?: 'apple-vm'
    }

/** Result of creating a private local execution box. */
export type VmProvisionResult =
  | { ok: true; target: Extract<ComputerTarget, { kind: 'vm' }>; detail: string }
  | { ok: false; error: string }

/** Stable stages exposed while the native VM runtime performs first-use work. */
export type VmProvisionStage =
  | 'idle'
  | 'preparing-runtime'
  | 'downloading-runtime'
  | 'starting-runtime'
  | 'installing-kernel'
  | 'building-image'
  | 'starting-vm'
  | 'checking-vm'
  | 'cancelling'
  | 'ready'
  | 'failed'
  | 'cancelled'

export interface VmProvisionProgress {
  stage: VmProvisionStage
  /** Human-readable status only; credentials and command output never belong here. */
  detail: string
}

/** Renderer-safe snapshot of the one managed-VM provisioning operation. */
export interface VmProvisionStatus extends VmProvisionProgress {
  active: boolean
  startedAt?: number
  updatedAt: number
}

/** Explicit input from the human takeover panel; never model-generated. */
export type HumanComputerAction =
  | { type: 'click'; x: number; y: number; button?: MouseButton; clickCount?: number }
  | { type: 'drag'; from: [number, number]; to: [number, number] }
  | { type: 'type'; text: string }
  | { type: 'key'; combo: string }
  | { type: 'scroll'; x: number; y: number; dx: number; dy: number }
  | { type: 'navigate'; url: string }
  | { type: 'openApp'; name: string }

export type ScreenControlResult =
  | { ok: true; frame: ScreenFrame }
  | { ok: false; error: string }

/** Output from an explicit human-admin command inside an OpenBOT-owned VM. */
export type VmAdminResult =
  | { ok: true; stdout: string; stderr: string; exitCode: number }
  | { ok: false; error: string }

export interface ScreenFrame {
  /** base64 PNG, no data: prefix. */
  image: string
  width: number
  height: number
  /** Ratio applied vs. the native display, so coords map back. */
  scale: number
}

export type MouseButton = 'left' | 'right' | 'middle'

export interface ComputerProbeResult {
  ok: boolean
  detail?: string
  /** Capability ids reported by an external target daemon. */
  capabilities?: string[]
  /** True only when both process and filesystem work stay inside the target. */
  isolatedExecution?: boolean
}

/**
 * Implemented once per target kind. Coordinates are always in the space of
 * the most recent `screenshot()` frame, never the native resolution.
 */
export interface ComputerProvider {
  readonly kind: ComputerTarget['kind']
  /** Verify the target is reachable and permissions are granted. */
  probe(signal?: AbortSignal): Promise<ComputerProbeResult>
  screenshot(signal?: AbortSignal): Promise<ScreenFrame>
  click(x: number, y: number, button?: MouseButton, clickCount?: number, signal?: AbortSignal): Promise<void>
  moveMouse(x: number, y: number, signal?: AbortSignal): Promise<void>
  typeText(text: string, signal?: AbortSignal): Promise<void>
  /** Lowercase, `+`-separated, modifiers first: "enter", "cmd+s". */
  keyPress(combo: string, signal?: AbortSignal): Promise<void>
  scroll(x: number, y: number, dx: number, dy: number, signal?: AbortSignal): Promise<void>
  drag(from: [number, number], to: [number, number], signal?: AbortSignal): Promise<void>
  openApp(name: string, signal?: AbortSignal): Promise<void>
  navigate(url: string, signal?: AbortSignal): Promise<void>
  /** Stable identity used by the per-app computer-use allowlist. */
  activeApp?(signal?: AbortSignal): Promise<string | undefined>
}
