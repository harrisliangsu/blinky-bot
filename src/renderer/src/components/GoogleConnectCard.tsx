import { useEffect, useState, type ReactNode } from 'react'
import type { AppStatus } from '../../../shared/apps'

export function GoogleConnectCard({ zh, service, status, statusLabel, refresh }: { zh: boolean; service: 'gmail' | 'calendar'; status?: AppStatus; statusLabel: string; refresh: () => void }): ReactNode {
  const [busy, setBusy] = useState(false), [removing, setRemoving] = useState(false), [error, setError] = useState('')
  const [disconnecting, setDisconnecting] = useState(false)
  const [removeAccountId, setRemoveAccountId] = useState<string | undefined>()
  const [selectedId, setSelectedId] = useState('')
  const ready = status?.detail === 'oauth-ready' || status?.detail === 'verification-failed-with-client' || status?.status === 'connected'
  const linked = status?.status === 'connected' || status?.status === 'unavailable'
  const selected = status?.accounts?.find(account => account.id === selectedId) ?? status?.accounts?.find(account => account.isDefault) ?? status?.accounts?.[0]
  const several = (status?.accounts?.length ?? 0) > 1
  const close = (): void => { setError(''); setRemoving(false); setRemoveAccountId(undefined) }
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') { void window.openbot.apps.cancelGoogle(); close() } }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [])
  const authorize = (options?: { addAccount?: boolean; accountId?: string }): void => {
    setBusy(true); setError('')
    void window.openbot.apps.connectGoogle(service, '', '', options).then((result) => {
      if (result.ok) close()
      else setError(result.error ?? (zh ? '授权未完成。请检查应用客户端、API 权限和网络后重试。' : 'Authorization did not complete. Check app setup, API access and the network.'))
    }).catch(() => setError(zh ? '授权未完成，请重试。' : 'Authorization did not complete. Please try again.')).finally(() => { setBusy(false); refresh() })
  }
  const disconnect = (accountId?: string): void => {
    setBusy(true); setDisconnecting(true)
    void window.openbot.apps.disconnectGoogle(service, accountId).then((result) => {
      if (result.ok) close()
      else setError(zh ? '无法移除本机连接。' : 'Could not remove the local connection.')
    }).catch(() => setError(zh ? '无法移除本机连接。' : 'Could not remove the local connection.')).finally(() => { setBusy(false); setDisconnecting(false); refresh() })
  }
  return <section className="ob-app-card" data-app={service}>
    <div className="ob-app-icon" aria-hidden="true">{service === 'gmail' ? 'M' : '日历'}</div>
    <div className="ob-app-summary"><h3>{service === 'gmail' ? 'Gmail' : 'Google Calendar'}</h3>
      <p className="ob-set-value">{statusLabel}{status?.account ? ` · ${status.account}` : ''}</p>
      <p className="ob-hint">{service === 'gmail' ? (zh ? '在浏览器中授权；发送邮件仍先审核草稿。' : 'Authorize in your browser; sending mail still requires draft review.') : (zh ? '在浏览器中授权；日程邀请仍先审核草稿。' : 'Authorize in your browser; calendar invitations still require draft review.')}</p>
      {status?.detail?.startsWith('verification-failed') ? <p className="ob-hint">{zh ? '无法验证连接，请检查网络、授权和 Google API。' : 'Could not verify the connection. Check network, authorization and Google API access.'}</p> : null}
      {status?.detail === 'oauth-client-required' ? <p className="ob-hint" role="status">{zh ? '此版本的 Google 浏览器登录尚未由发行方启用。启用后只需登录并同意授权，无需申请开发者应用或填写 API key。' : 'Google browser sign-in has not been enabled by this distributor. Once enabled, just sign in and consent; no developer app or API key is needed.'}</p> : null}
    </div>
    <div className="ob-apps-google-actions">
      {busy ? <button type="button" className="ob-btn ob-btn-sm" disabled={disconnecting} onClick={() => void window.openbot.apps.cancelGoogle()}>{disconnecting ? (zh ? '正在断开…' : 'Disconnecting…') : (zh ? '取消' : 'Cancel')}</button> : <>
        <button type="button" className="ob-btn ob-btn-sm ob-btn-primary" disabled={!status || !ready} onClick={() => { setError(''); if (ready) authorize(several && selected ? { accountId: selected.id } : undefined) }}>{linked ? (several ? (zh ? '重新授权此账户' : 'Reconnect this account') : (zh ? '重新授权' : 'Reconnect')) : (zh ? '连接' : 'Connect')}</button>
        {linked ? <button type="button" className="ob-btn ob-btn-sm" onClick={() => { setRemoveAccountId(several ? selected?.id : undefined); setRemoving(true) }}>{several ? (zh ? '断开此账户' : 'Disconnect this account') : (zh ? '断开' : 'Disconnect')}</button> : null}
        {linked && ready ? <button type="button" className="ob-btn ob-btn-sm" onClick={() => authorize({ addAccount: true })}>{zh ? '添加其他账号' : 'Add another account'}</button> : null}
      </>}
    </div>
    {several ? <div className="ob-google-account-picker ob-apps-connection-note">
      <label className="ob-hint">{zh ? '管理账户' : 'Manage account'}<select className="ob-select" aria-label={`${service === 'gmail' ? 'Gmail' : 'Calendar'} ${zh ? '账户' : 'account'}`} value={selected?.id ?? ''} disabled={busy} onChange={event => setSelectedId(event.target.value)}>{status!.accounts!.map(account => <option key={account.id} value={account.id}>{account.label}{account.isDefault ? (zh ? ' · 默认' : ' · Default') : ''}{account.status !== 'connected' ? (zh ? ' · 连接不可用' : ' · Unavailable') : ''}</option>)}</select></label>
      <p className="ob-hint">{zh ? '选择仅用于管理此账户。查询时可让 Bot 按账户名称选择。' : 'Selection manages this account only. Ask the Bot to choose an account by name.'}</p>
    </div> : null}
    {removing ? <div className="ob-apps-git ob-apps-google">
      <p className="ob-hint">{zh ? `移除此账户的本机授权${removeAccountId ? `（${status?.accounts?.find(account => account.id === removeAccountId)?.label ?? ''}）` : ''}。不会撤销 Google 中的授权；已发出的请求可能仍会完成。` : 'Removes this account locally. Google consent is not revoked; submitted requests may still complete.'}</p>
      <button type="button" className="ob-btn ob-btn-sm" disabled={busy} onClick={() => disconnect(removeAccountId)}>{zh ? '确认断开' : 'Disconnect'}</button>
      <button type="button" className="ob-btn ob-btn-sm" disabled={busy} onClick={() => setRemoving(false)}>{zh ? '取消' : 'Cancel'}</button>
    </div> : null}
    {busy ? <p className="ob-hint ob-apps-connection-note" role="status">{disconnecting ? (zh ? '正在移除本机授权…' : 'Removing local credentials…') : (zh ? '请在浏览器完成授权或取消。' : 'Complete authorization in your browser or cancel.')}</p> : null}
    {error ? <p className="ob-notice ob-notice-error ob-apps-connection-note" role="alert">{error}</p> : null}
  </section>
}
