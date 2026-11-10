import { Modal } from './Modal'
import { useEffect, useState, type ReactNode } from 'react'
import type { AppStatus } from '../../../shared/apps'
import type { Bot } from '../../../shared/types'
import { BotAppAccess } from './BotAppAccess'

export function XConnectCard({ zh, status, statusLabel, refresh, accessBot }: { zh: boolean; status?: AppStatus; statusLabel: string; refresh: () => void; accessBot?: Bot }): ReactNode {
  const [editing, setEditing] = useState(false), [clientId, setClientId] = useState(''), [busy, setBusy] = useState(false), [removing, setRemoving] = useState(false), [error, setError] = useState('')
  const [disconnecting, setDisconnecting] = useState(false)
  const ready = status?.detail === 'oauth-ready' || status?.detail === 'verification-failed-with-client' || status?.status === 'connected'
  const close = (): void => { setEditing(false); setClientId(''); setRemoving(false); setError('') }
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') { void window.openbot.apps.cancelX(); close() } }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [])
  const authorize = (manual = false): void => {
    setBusy(true); setError('')
    const connection = accessBot ? window.openbot.apps.connectX(manual ? clientId : '', accessBot.id) : window.openbot.apps.connectX(manual ? clientId : '')
    void connection.then((result) => {
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
      {busy ? <button type="button" className="ob-btn ob-btn-sm" disabled={disconnecting} onClick={() => void window.openbot.apps.cancelX()}>{disconnecting ? (zh ? '正在断开…' : 'Disconnecting…') : (zh ? '取消授权' : 'Cancel authorization')}</button> : <>
        <button type="button" className="ob-btn ob-btn-sm" disabled={!status || !ready} onClick={() => { setError(''); if (ready) authorize() }}>{ready ? (status?.status === 'connected' ? (zh ? '重新授权' : 'Reconnect') : (zh ? '浏览器登录' : 'Sign in with browser')) : (zh ? '浏览器登录暂不可用' : 'Browser sign-in unavailable')}</button>
        {status?.status === 'connected' || status?.status === 'unavailable' ? <button type="button" className="ob-btn ob-btn-sm" onClick={() => setRemoving(true)}>{zh ? '断开' : 'Disconnect'}</button> : null}
      </>}
    </div>
    {removing ? <div className="ob-apps-git ob-apps-google">
      <p className="ob-hint">{zh ? '移除本机凭据，不撤销 X 中的应用授权。已发出的请求可能仍会完成。' : 'Removes local credentials without revoking X consent. An already submitted request may still complete.'}</p>
      <button type="button" className="ob-btn ob-btn-sm" disabled={busy} onClick={() => { setBusy(true); setDisconnecting(true); void window.openbot.apps.disconnectX().then((result) => { if (result.ok) close(); else setError(zh ? '无法移除连接。' : 'Could not remove connection.') }).catch(() => setError(zh ? '无法移除连接。' : 'Could not remove connection.')).finally(() => { setBusy(false); setDisconnecting(false); refresh() }) }}>{zh ? '确认断开' : 'Disconnect'}</button>
      <button type="button" className="ob-btn ob-btn-sm" disabled={busy} onClick={() => setRemoving(false)}>{zh ? '取消' : 'Cancel'}</button>
    </div> : null}
    {!busy && !editing && status ? <button type="button" className="ob-btn ob-btn-sm ob-apps-configure" onClick={() => { setEditing(true); setError('') }}>{zh ? '高级：自带客户端…' : 'Advanced: bring your own client…'}</button> : null}
    {editing ? <Modal title={zh ? 'X 连接设置' : 'X connection settings'} onClose={() => setEditing(false)} size="md"><div className="ob-apps-git ob-apps-google">
      {error ? <p role="alert" className="ob-notice ob-notice-error">{error}</p> : null}
      <p className="ob-hint">{zh ? '高级配置：使用自己的 X Native App 客户端，开启读写权限并登记下方精确回调地址。客户端 ID 不是 API key；浏览器中仍需用户授权。' : 'Advanced: use your X Native App client with read/write permissions and the exact callback below. A client ID is not an API key; browser consent is still required.'} <a href="https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code" target="_blank" rel="noreferrer">{zh ? '配置说明' : 'Setup'}</a></p>
      <p className="ob-hint">{zh ? '回调地址' : 'Callback URL'}：<code>http://127.0.0.1:47839/oauth/x/callback</code></p>
      <input className="ob-input" aria-label="X OAuth client ID" placeholder="X OAuth client ID" value={clientId} autoComplete="off" onChange={(event) => setClientId(event.target.value)} disabled={busy} />
      <button type="button" className="ob-btn ob-btn-sm" disabled={busy || !clientId.trim()} onClick={() => authorize(true)}>{zh ? '在浏览器中授权' : 'Authorize in browser'}</button>
      <button type="button" className="ob-btn ob-btn-sm" disabled={busy} onClick={close}>{zh ? '取消' : 'Cancel'}</button>
    </div></Modal> : null}
    {busy ? <p className="ob-hint ob-apps-connection-note" role="status">{disconnecting ? (zh ? '正在移除本机授权…' : 'Removing local credentials…') : (zh ? '请在浏览器完成授权或取消。' : 'Complete authorization in your browser or cancel.')}</p> : null}
    {error ? <p className="ob-notice ob-notice-error ob-apps-connection-note" role="alert">{error}</p> : null}
    {accessBot ? <BotAppAccess service="x" bot={accessBot} connected={status?.status === 'connected'} zh={zh} /> : null}
  </section>
}
