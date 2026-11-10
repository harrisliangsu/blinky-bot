import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { ComputerTarget, VmProvisionStatus } from '../../../shared/types'
import { useBotChinese } from './BotUiLanguage'
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
  const zh = useBotChinese()
  const [browserScope, setBrowserScope] = useState<'legacy' | 'session' | 'unknown'>('unknown')
  useEffect(() => {
    let alive = true
    if (target.kind !== 'browser' || !target.botId) { setBrowserScope('unknown'); return () => { alive = false } }
    setBrowserScope('unknown')
    void window.openbot.bots.browserScope(target.botId).then((result) => {
      if (alive) setBrowserScope('mode' in result ? result.mode : 'unknown')
    }).catch(() => { if (alive) setBrowserScope('unknown') })
    return () => { alive = false }
  }, [target.kind, target.kind === 'browser' ? target.botId : ''])
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
      <span className="ob-label">{zh ? '执行环境' : 'Execution target'}</span>
      <div className="ob-mode" role="group" aria-label={zh ? '电脑执行环境' : 'Computer target'}>
        <button
          type="button"
          className={`ob-mode-btn${target.kind === 'local' ? ' is-active' : ''}`}
          aria-pressed={target.kind === 'local'}
          disabled={provisioning}
          onClick={() => onChange({ kind: 'local' })}
        >
          {zh ? '这台 Mac' : 'This Mac'}
        </button>
        <button
          type="button"
          className={`ob-mode-btn${isBrowser ? ' is-active' : ''}`}
          aria-pressed={isBrowser}
          disabled={provisioning}
          onClick={() => onChange({ kind: 'browser', botId: target.kind === 'browser' ? target.botId : '', provider: target.kind === 'browser' ? target.provider ?? 'chrome' : 'ego' })}
        >
          {zh ? 'Bot 浏览器' : 'Bot browser'}
        </button>
        <button type="button" className={`ob-mode-btn${isVm ? ' is-active' : ''}`} aria-pressed={isVm} disabled={provisioning} onClick={() => onChange(vmDraft)}>
          {zh ? 'Bot 虚拟机' : 'Bot VM'}
        </button>
      </div>

      {isBrowser ? (
        <div className="ob-mode" role="group" aria-label={zh ? '浏览器' : 'Browser'}>
          {(['ego', 'chrome'] as const).map((provider) => (
            <button key={provider} type="button" className={`ob-mode-btn${(target.provider ?? 'chrome') === provider ? ' is-active' : ''}`}
              aria-pressed={(target.provider ?? 'chrome') === provider} disabled={provisioning}
              onClick={() => onChange({ ...target, provider })}>
              {provider === 'ego' ? 'Ego Browser' : 'Chrome'}
            </button>
          ))}
        </div>
      ) : null}

      <p className="ob-hint">
        {isVm
          ? (zh ? 'Bot 在独立虚拟机中操作；只有虚拟机服务支持隔离执行时才能运行文件及命令工具。' : 'The bot drives its own virtual machine. Host shell and file tools are refused unless its daemon supports isolated execution.')
          : isBrowser
            ? (target.provider === 'ego'
                ? (zh ? 'Bot 使用独立的 Ego 浏览器空间。' : 'The bot uses its own Ego browser space.')
                : (zh ? 'Bot 使用独立的 Chrome 浏览器资料。' : 'The bot uses its own Chrome browser profile.'))
            : (zh ? 'Bot 直接操作这台电脑，可查看屏幕并控制输入。' : 'The bot drives this machine directly — it sees your screen and controls your input.')}
      </p>
      {isBrowser ? <p className="ob-hint" role="status">{browserScope === 'legacy'
        ? (zh ? '此 Bot 沿用旧浏览器资料，各会话可能共享页面和登录状态，尚未按会话隔离。' : 'This Bot keeps its legacy browser profile. Conversations may share pages and sign-ins; session isolation is not active.')
        : browserScope === 'session'
          ? (zh ? '浏览器资料按会话隔离；不同会话需要分别登录。' : 'Browser profiles are isolated per conversation; sign in separately in each one.')
          : (zh ? '浏览器会话隔离状态尚未确认。' : 'Browser session isolation has not been confirmed.')}</p> : null}

      {isVm ? (
        <div className="ob-target-fields">
          <div className="ob-target-provision">
            <div>
              <strong>{zh ? '专属托管虚拟机' : 'Private managed VM'}</strong>
              <p className="ob-hint">{zh ? '启动独立的 Linux 虚拟机，提供持久文件、桌面和 Chromium。首次设置会下载 Apple 签名的运行时和虚拟机内核。' : "Boots a dedicated Linux VM with persistent files, a desktop and Chromium. First setup downloads Apple's signed runtime and VM kernel."}</p>
            </div>
            <button
              type="button"
              className="ob-btn ob-btn-sm"
              disabled={cancelling}
              onClick={() => void (provisioning ? cancelProvision() : provision())}
            >
              {cancelling
                ? (zh ? '正在取消…' : 'Cancelling…')
                : provisioning
                  ? (zh ? '取消设置' : 'Cancel setup')
                  : target.managed === 'apple-vm'
                    ? (zh ? '替换虚拟机' : 'Replace VM')
                    : (zh ? '创建虚拟机' : 'Create VM')}
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

          {target.managed === 'apple-vm' ? <p className="ob-hint ob-target-managed">{zh ? '专属 Apple 虚拟机 · 随 Bot 删除' : 'Dedicated Apple VM · deleted with this bot'}</p> : null}
          <div className="ob-field">
            <label htmlFor="ob-vm-id">{zh ? '虚拟机 ID' : 'VM id'}</label>
            <input
              id="ob-vm-id"
              className="ob-input"
              value={target.vmId}
              placeholder={zh ? '虚拟机服务分配的 ID' : 'Id from the VM supervisor'}
              onChange={(e) => setVm({ vmId: e.target.value })}
              readOnly={target.managed === 'apple-vm'}
            />
          </div>

          <div className="ob-field">
            <label htmlFor="ob-vm-endpoint">{zh ? '控制地址' : 'Control endpoint'}</label>
            <input
              id="ob-vm-endpoint"
              className="ob-input"
              value={target.endpoint}
              placeholder={zh ? '本机控制服务地址' : 'Loopback URL of the control daemon'}
              onChange={(e) => setVm({ endpoint: e.target.value })}
              readOnly={target.managed === 'apple-vm'}
            />
          </div>

          <div className="ob-field">
            <label htmlFor="ob-vm-token">{zh ? '访问令牌' : 'Token'}</label>
            <input
              id="ob-vm-token"
              className="ob-input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={target.token ?? ''}
              placeholder={
                target.managed === 'apple-vm'
                  ? (zh ? '由 BlinkyBot 管理' : 'Credential managed by BlinkyBot')
                  : target.hasToken
                    ? (zh ? '已安全保存，留空则保持不变' : 'Stored securely — leave blank to keep')
                    : (zh ? '必填，保存在系统钥匙串中' : 'Required — stored in the OS keychain')
              }
              onChange={(e) => setVm({ token: e.target.value })}
              readOnly={target.managed === 'apple-vm'}
            />
          </div>

          {!target.vmId.trim() || !target.endpoint.trim() || (!target.hasToken && !target.token?.trim()) ? (
            <p className="ob-hint">{zh ? '保存前请填写虚拟机 ID、本机控制地址和访问令牌。' : 'A VM id, loopback endpoint, and per-VM token are required before this bot can be saved.'}</p>
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
