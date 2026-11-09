import { useEffect, useState, type ReactNode } from 'react'
import type { NotificationStatus } from '../../../shared/desktopNotifications'
export function NotificationDelivery({ zh }: { zh: boolean }): ReactNode {
  const [status, setStatus] = useState<NotificationStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [settingsError, setSettingsError] = useState(false)
  useEffect(() => {
    let alive = true
    const refresh = (): void => { void window.openbot.notifications.status().then(s => { if (alive) setStatus(s) }).catch(() => { if (alive) setStatus(null) }) }
    refresh(); const timer = setInterval(refresh, 2000)
    return () => { alive = false; clearInterval(timer) }
  }, [])
  const message = !status ? (zh ? '暂时无法读取通知状态。' : 'Notification status is unavailable.')
    : status.hostManaged ? (zh ? '通知由 Mac 主机投递。请在 Mac 开启系统通知并检查专注模式；此远程页保留消息和任务状态，不申请浏览器推送权限。' : 'Notifications are delivered by the Mac. Enable them and check Focus there; this remote page shows messages and task status without requesting browser push access.')
    : !status.supported ? (zh ? '系统暂不支持通知。' : 'System notifications are unavailable.')
      : status.state === 'failed' ? (zh ? '系统未能显示通知。请在系统设置中检查 BlinkyBot 的通知权限。' : 'The system could not show the notification. Check BlinkyBot notification permissions in System Settings.')
        : status.state === 'shown' ? (zh ? '通知已交给系统，横幅显示仍受通知权限和专注模式控制。' : 'The notification was handed to the system. Permission and Focus still control banner presentation.')
          : status.state === 'requested' ? (zh ? '正在请求系统显示测试通知…' : 'Requesting a test notification…')
            : status.state === 'unconfirmed' ? (zh ? '系统尚未确认通知是否显示。请检查通知权限和专注模式。' : 'The system has not confirmed delivery. Check notification permissions and Focus.')
          : (zh ? '通知由 macOS 控制。若未显示，请允许通知，并检查专注模式。通知不包含对话正文。' : 'macOS controls delivery. If no notification appears, allow notifications and check Focus. Notifications contain no conversation text.')
  return <div className="ob-notification-delivery"><p role="status">{message}</p>{settingsError ? <p role="alert">{zh ? '无法打开系统设置，请手动打开“系统设置 → 通知”。' : 'Could not open System Settings. Open Notifications manually.'}</p> : null}<div className="ob-inline-actions">
    <button type="button" className="ob-btn ob-btn-sm" disabled={busy || !status?.enabled || !status.supported} onClick={() => {
      setBusy(true); void window.openbot.notifications.test().then(() => window.openbot.notifications.status()).then(setStatus).catch(() => setStatus(null)).finally(() => setBusy(false))
    }}>{zh ? '发送测试通知' : 'Send test notification'}</button>
    {!status?.hostManaged ? <button type="button" className="ob-btn ob-btn-sm" onClick={() => { setSettingsError(false); void window.openbot.notifications.openSettings().catch(() => setSettingsError(true)) }}>{zh ? '系统通知设置' : 'System notification settings'}</button> : null}
  </div>{!status?.hostManaged ? <p className="ob-hint">{zh ? '在系统通知列表中选择 BlinkyBot；如果尚未出现，请先发送测试通知。' : 'Select BlinkyBot in the system notification list. If it is absent, send a test notification first.'}</p> : null}</div>
}
