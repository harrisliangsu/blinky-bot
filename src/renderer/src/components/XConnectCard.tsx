import { useEffect, useState, type ReactNode } from 'react'
import type { AppStatus } from '../../../shared/apps'

export function XConnectCard({ zh, status, statusLabel, refresh }: { zh: boolean; status?: AppStatus; statusLabel: string; refresh: () => void }): ReactNode {
  const [busy, setBusy] = useState(false), [removing, setRemoving] = useState(false), [error, setError] = useState('')
  const [disconnecting, setDisconnecting] = useState(false)
  const ready = status?.detail === 'oauth-ready' || status?.detail === 'verification-failed-with-client' || status?.status === 'connected'
  const linked = status?.status === 'connected' || status?.status === 'unavailable'
  const close = (): void => { setRemoving(false); setError('') }
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') { void window.openbot.apps.cancelX(); close() } }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [])
  const authorize = (): void => {
    setBusy(true); setError('')
    void window.openbot.apps.connectX('').then((result) => {
      if (result.ok) close()
      else setError(result.error || (zh ? '授权未完成，请检查应用客户端、回调地址和 X API 权限。' : 'Authorization did not complete. Check the app client, callback and X API access.'))
    }).catch(() => setError(zh ? '授权未完成。' : 'Authorization did not complete.')).finally(() => { setBusy(false); refresh() })
  }
  return <section className="ob-app-card" data-app="x">
    <div className="ob-app-icon" aria-hidden="true">𝕏</div>
    <div className="ob-app-summary"><h3>X</h3><p className="ob-set-value">{statusLabel}{status?.account ? ` · @${status.account}` : ''}</p>
      <p className="ob-hint">{zh ? '浏览器授权后可读取帖子；发布和回复须审核草稿。API 能力及费用由 X 决定。' : 'Authorize in your browser to read posts; posting and replies require draft review. X controls API access and costs.'}</p>
      {status?.detail === 'oauth-client-required' ? <p className="ob-hint" role="status">{zh ? '此版本的 X 浏览器登录尚未由发行方启用。启用后只需登录并同意授权，无需申请开发者应用或填写 API key。' : 'X browser sign-in has not been enabled by this distributor. Once enabled, just sign in and consent; no developer app or API key is needed.'}</p> : null}
      {status?.detail?.startsWith('verification-failed') ? <p className="ob-hint">{zh ? '无法验证连接，请检查授权、网络和 X API 权限。' : 'Could not verify the connection. Check authorization, network and X API access.'}</p> : null}
    </div>
    <div className="ob-apps-google-actions">
      {busy ? <button type="button" className="ob-btn ob-btn-sm" disabled={disconnecting} onClick={() => void window.openbot.apps.cancelX()}>{disconnecting ? (zh ? '正在断开…' : 'Disconnecting…') : (zh ? '取消' : 'Cancel')}</button> : <>
        <button type="button" className="ob-btn ob-btn-sm ob-btn-primary" disabled={!status || !ready} onClick={() => { setError(''); if (ready) authorize() }}>{linked ? (zh ? '重新授权' : 'Reconnect') : (zh ? '连接' : 'Connect')}</button>
        {linked ? <button type="button" className="ob-btn ob-btn-sm" onClick={() => setRemoving(true)}>{zh ? '断开' : 'Disconnect'}</button> : null}
      </>}
    </div>
    {removing ? <div className="ob-apps-git ob-apps-google">
      <p className="ob-hint">{zh ? '移除本机凭据，不撤销 X 中的应用授权。已发出的请求可能仍会完成。' : 'Removes local credentials without revoking X consent. An already submitted request may still complete.'}</p>
      <button type="button" className="ob-btn ob-btn-sm" disabled={busy} onClick={() => { setBusy(true); setDisconnecting(true); void window.openbot.apps.disconnectX().then((result) => { if (result.ok) close(); else setError(zh ? '无法移除连接。' : 'Could not remove connection.') }).catch(() => setError(zh ? '无法移除连接。' : 'Could not remove connection.')).finally(() => { setBusy(false); setDisconnecting(false); refresh() }) }}>{zh ? '确认断开' : 'Disconnect'}</button>
      <button type="button" className="ob-btn ob-btn-sm" disabled={busy} onClick={() => setRemoving(false)}>{zh ? '取消' : 'Cancel'}</button>
    </div> : null}
    {busy ? <p className="ob-hint ob-apps-connection-note" role="status">{disconnecting ? (zh ? '正在移除本机授权…' : 'Removing local credentials…') : (zh ? '请在浏览器完成授权或取消。' : 'Complete authorization in your browser or cancel.')}</p> : null}
    {error ? <p className="ob-notice ob-notice-error ob-apps-connection-note" role="alert">{error}</p> : null}
  </section>
}
