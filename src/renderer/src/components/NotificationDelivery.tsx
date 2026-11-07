import { useEffect, useState, type ReactNode } from 'react'
import type { NotificationStatus } from '../../../shared/desktopNotifications'
export function NotificationDelivery({ zh }: { zh: boolean }): ReactNode {
  const [status, setStatus] = useState<NotificationStatus | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let alive = true
    const refresh = (): void => { void window.openbot.notifications.status().then(s => { if (alive) setStatus(s) }).catch(() => { if (alive) setStatus(null) }) }
    refresh(); const timer = setInterval(refresh, 2000)
    return () => { alive = false; clearInterval(timer) }
  }, [])
  const message = !status ? (zh ? '暂时无法读取通知状态。' : 'Notification status is unavailable.')
    : !status.supported ? (zh ? '系统暂不支持通知。' : 'System notifications are unavailable.')
      : status.state === 'failed' ? (zh ? '系统未能显示通知。请在系统设置中检查 BlinkyBot 的通知权限。' : 'The system could not show the notification. Check BlinkyBot notification permissions in System Settings.')
        : status.state === 'shown' ? (zh ? '系统已确认通知投递。' : 'System notification delivery confirmed.')
          : (zh ? '通知由 macOS 控制。若未显示，请允许通知，并检查专注模式。通知不包含对话正文。' : 'macOS controls delivery. If no notification appears, allow notifications and check Focus. Notifications contain no conversation text.')
  return <div className="ob-notification-delivery"><p role="status">{message}</p><div className="ob-inline-actions">
    <button type="button" className="ob-btn ob-btn-sm" disabled={busy || !status?.enabled || !status.replies || !status.supported} onClick={() => {
      setBusy(true); void window.openbot.notifications.test().then(() => window.openbot.notifications.status()).then(setStatus).finally(() => setBusy(false))
    }}>{zh ? '发送测试通知' : 'Send test notification'}</button>
    <button type="button" className="ob-btn ob-btn-sm" onClick={() => void window.openbot.notifications.openSettings()}>{zh ? '系统通知设置' : 'System notification settings'}</button>
  </div></div>
}
