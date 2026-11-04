import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ComputerTarget, VmProvisionStatus } from '../../../shared/types'
import './BotTargetFields.css'

interface BotTargetFieldsProps {
  target: ComputerTarget
  onChange: (target: ComputerTarget) => void
  onProvision: () => Promise<VmTarget | null>
  onProvisionStatus: () => Promise<VmProvisionStatus>
  onCancelProvision: () => Promise<VmProvisionStatus>
}

type VmTarget = Extract<ComputerTarget, { kind: 'vm' }>

const emptyVm: VmTarget = { kind: 'vm', vmId: '', endpoint: '' }

/** Chooses the bot's computer and, for a capable VM daemon, execution boundary. */
export function BotTargetFields({
  target,
  onChange,
  onProvision,
  onProvisionStatus,
  onCancelProvision
}: BotTargetFieldsProps): ReactNode {
  // Remembered so switching back to VM does not wipe what was typed.
  const [vmDraft, setVmDraft] = useState<VmTarget>(target.kind === 'vm' ? target : emptyVm)
  const [requestPending, setRequestPending] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [showProvisionStatus, setShowProvisionStatus] = useState(false)
  const [provisionStatus, setProvisionStatus] = useState<VmProvisionStatus>({
    active: false,
    stage: 'idle',
    detail: 'Ready to create a private VM.',
    updatedAt: Date.now()
  })
  const activeRef = useRef(false)

  const provisioning = requestPending || provisionStatus.active
  activeRef.current = provisioning

  useEffect(() => {
    let disposed = false
    const poll = async (): Promise<void> => {
      const next = await onProvisionStatus()
      if (disposed) return
      if (next.active) setShowProvisionStatus(true)
      if (next.active || activeRef.current) setProvisionStatus(next)
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 750)
    return () => {
      disposed = true
      window.clearInterval(timer)
      if (activeRef.current) void onCancelProvision()
    }
  }, [onCancelProvision, onProvisionStatus])

  const provision = async (): Promise<void> => {
    setShowProvisionStatus(true)
    setRequestPending(true)
    setProvisionStatus({
      active: true,
      stage: 'preparing-runtime',
      detail: 'Preparing the native VM runtime…',
      startedAt: Date.now(),
      updatedAt: Date.now()
    })
    try {
      const next = await onProvision()
      if (!next) return
      setVmDraft(next)
      onChange(next)
    } finally {
      setRequestPending(false)
      setProvisionStatus(await onProvisionStatus())
    }
  }

  const cancelProvision = async (): Promise<void> => {
    setCancelling(true)
    setShowProvisionStatus(true)
    try {
      setProvisionStatus(await onCancelProvision())
    } finally {
      setCancelling(false)
    }
  }

  const setVm = (patch: Partial<VmTarget>): void => {
    const next: VmTarget = { ...vmDraft, ...patch }
    setVmDraft(next)
    onChange(next)
  }

  const isVm = target.kind === 'vm'
  const isBrowser = target.kind === 'browser'

  return (
    <div className="ob-field">
      <span className="ob-label">Execution target</span>
      <div className="ob-mode" role="group" aria-label="Computer target">
        <button
          type="button"
          className={`ob-mode-btn${target.kind === 'local' ? ' is-active' : ''}`}
          aria-pressed={target.kind === 'local'}
          disabled={provisioning}
          onClick={() => onChange({ kind: 'local' })}
        >
          This Mac
        </button>
        <button
          type="button"
          className={`ob-mode-btn${isBrowser ? ' is-active' : ''}`}
          aria-pressed={isBrowser}
          disabled={provisioning}
          onClick={() => onChange({ kind: 'browser', botId: target.kind === 'browser' ? target.botId : '' })}
        >
          Bot browser
        </button>
        <button type="button" className={`ob-mode-btn${isVm ? ' is-active' : ''}`} aria-pressed={isVm} disabled={provisioning} onClick={() => onChange(vmDraft)}>
          Bot VM
        </button>
      </div>

      <p className="ob-hint">
        {isVm
          ? 'The bot drives its own virtual machine. Host shell and file tools are refused unless its daemon supports isolated execution.'
          : isBrowser
            ? 'The bot gets its own persistent browser profile, isolated from your cookies and signed-in sessions.'
            : 'The bot drives this machine directly — it sees your screen and controls your input.'}
      </p>

      {isVm ? (
        <div className="ob-target-fields">
          <div className="ob-target-provision">
            <div>
              <strong>Private managed VM</strong>
              <p className="ob-hint">Boots a dedicated lightweight Linux VM with persistent files, a graphical desktop, and Chromium. Human takeover includes direct mouse/keyboard control and an administrator terminal for installing apps. First setup downloads Apple's signed runtime and VM kernel.</p>
            </div>
            <button
              type="button"
              className="ob-btn ob-btn-sm"
              disabled={cancelling}
              onClick={() => void (provisioning ? cancelProvision() : provision())}
            >
              {cancelling
                ? 'Cancelling…'
                : provisioning
                  ? 'Cancel setup'
                  : target.managed === 'apple-vm'
                    ? 'Replace VM'
                    : 'Create VM'}
            </button>
          </div>

          {showProvisionStatus && provisionStatus.stage !== 'idle' ? (
            <div
              className={`ob-target-progress${provisionStatus.stage === 'failed' ? ' is-error' : ''}`}
              role="status"
              aria-live="polite"
            >
              {provisioning ? <span className="ob-target-progress-dot" aria-hidden="true" /> : null}
              <span>{provisionStatus.detail}</span>
              {provisioning && provisionStatus.startedAt ? (
                <span className="ob-target-elapsed">
                  {formatElapsed(Date.now() - provisionStatus.startedAt)}
                </span>
              ) : null}
            </div>
          ) : null}

          {target.managed === 'apple-vm' ? <p className="ob-hint ob-target-managed">Dedicated Apple VM · deleted with this bot</p> : null}
          <div className="ob-field">
            <label htmlFor="ob-vm-id">VM id</label>
            <input
              id="ob-vm-id"
              className="ob-input"
              value={target.vmId}
              placeholder="Id from the VM supervisor"
              onChange={(e) => setVm({ vmId: e.target.value })}
              readOnly={target.managed === 'apple-vm'}
            />
          </div>

          <div className="ob-field">
            <label htmlFor="ob-vm-endpoint">Control endpoint</label>
            <input
              id="ob-vm-endpoint"
              className="ob-input"
              value={target.endpoint}
              placeholder="Loopback URL of the control daemon"
              onChange={(e) => setVm({ endpoint: e.target.value })}
              readOnly={target.managed === 'apple-vm'}
            />
          </div>

          <div className="ob-field">
            <label htmlFor="ob-vm-token">Token</label>
            <input
              id="ob-vm-token"
              className="ob-input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={target.token ?? ''}
              placeholder={
                target.managed === 'apple-vm'
                  ? 'Credential managed by BlinkyBot'
                  : target.hasToken
                    ? 'Stored securely — leave blank to keep'
                    : 'Required — stored in the OS keychain'
              }
              onChange={(e) => setVm({ token: e.target.value })}
              readOnly={target.managed === 'apple-vm'}
            />
          </div>

          {!target.vmId.trim() || !target.endpoint.trim() || (!target.hasToken && !target.token?.trim()) ? (
            <p className="ob-hint">A VM id, loopback endpoint, and per-VM token are required before this bot can be saved.</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return minutes > 0 ? `${minutes}m ${String(remainder).padStart(2, '0')}s` : `${remainder}s`
}
