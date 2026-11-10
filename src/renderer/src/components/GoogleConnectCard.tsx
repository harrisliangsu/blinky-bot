import { Modal } from './Modal'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AppStatus } from '../../../shared/apps'
import type { Bot } from '../../../shared/types'
import { BotAppAccess } from './BotAppAccess'

export function GoogleConnectCard({ zh, service, status, statusLabel, refresh, accessBot }: { zh: boolean; service: 'gmail' | 'calendar'; status?: AppStatus; statusLabel: string; refresh: () => void; accessBot?: Bot }): ReactNode {
  const [editing, setEditing] = useState(false), [clientId, setClientId] = useState(''), [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false), [removing, setRemoving] = useState(false), [error, setError] = useState('')
  const [disconnecting, setDisconnecting] = useState(false)
  const [removeAccountId, setRemoveAccountId] = useState<string | undefined>()
  const [selectedId, setSelectedId] = useState('')
  const importVersion = useRef(0)
  const ready = status?.detail === 'oauth-ready' || status?.detail === 'verification-failed-with-client' || status?.status === 'connected'
  const selected = status?.accounts?.find(account => account.id === selectedId) ?? status?.accounts?.find(account => account.isDefault) ?? status?.accounts?.[0]
  const close = (): void => { importVersion.current++; setEditing(false); setClientId(''); setSecret(''); setError(''); setRemoving(false); setRemoveAccountId(undefined) }
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') { void window.openbot.apps.cancelGoogle(); close() } }
    window.addEventListener('keydown', escape)
    return () => { importVersion.current++; window.removeEventListener('keydown', escape) }
  }, [])
  const authorize = (manual = false, options?: { addAccount?: boolean; accountId?: string }): void => {
    const inputSecret = secret; setSecret(''); setBusy(true); setError('')
    void window.openbot.apps.connectGoogle(service, manual ? clientId : '', manual ? inputSecret : '', accessBot ? { ...options, botId: accessBot.id } : options).then((result) => {
      if (result.ok) close()
      else setError(result.error ?? (zh ? '授权未完成。请检查应用客户端、API 权限和网络后重试。' : 'Authorization did not complete. Check app setup, API access and the network.'))
    }).catch(() => setError(zh ? '授权未完成，请重试。' : 'Authorization did not complete. Please try again.')).finally(() => { setBusy(false); refresh() })
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
      {busy ? <button type="button" className="ob-btn ob-btn-sm" disabled={disconnecting} onClick={() => void window.openbot.apps.cancelGoogle()}>{disconnecting ? (zh ? '正在断开…' : 'Disconnecting…') : (zh ? '取消授权' : 'Cancel authorization')}</button> : <>
        <button type="button" className="ob-btn ob-btn-sm" disabled={!status || !ready} onClick={() => { setError(''); if (ready) authorize() }}>{ready ? (status?.status === 'connected' ? (zh ? '重新授权默认账户' : 'Reconnect default') : (zh ? '浏览器登录' : 'Sign in with browser')) : (zh ? '浏览器登录暂不可用' : 'Browser sign-in unavailable')}</button>
        {status?.status === 'connected' || status?.status === 'unavailable' ? <button type="button" className="ob-btn ob-btn-sm" onClick={() => { setRemoveAccountId(undefined); setRemoving(!removing) }}>{zh ? '断开默认账户' : 'Disconnect default'}</button> : null}
      </>}
    </div>
    {status?.accounts?.length ? <div className="ob-google-account-picker ob-apps-connection-note">
      <label className="ob-hint">{zh ? '管理账户' : 'Manage account'}<select className="ob-select" aria-label={`${service === 'gmail' ? 'Gmail' : 'Calendar'} ${zh ? '账户' : 'account'}`} value={selected?.id ?? ''} disabled={busy} onChange={event => setSelectedId(event.target.value)}>{status.accounts.map(account => <option key={account.id} value={account.id}>{account.label}{account.isDefault ? (zh ? ' · 默认' : ' · Default') : ''}{account.status !== 'connected' ? (zh ? ' · 连接不可用' : ' · Unavailable') : ''}</option>)}</select></label>
      <div className="ob-apps-google-actions"><button type="button" className="ob-btn ob-btn-sm" disabled={busy || !selected} onClick={() => authorize(false, { accountId: selected!.id })}>{zh ? '重新授权此账户' : 'Reconnect this account'}</button><button type="button" className="ob-btn ob-btn-sm" disabled={busy || !selected} onClick={() => { setRemoveAccountId(selected!.id); setRemoving(true) }}>{zh ? '断开此账户' : 'Disconnect this account'}</button></div>
      <p className="ob-hint">{zh ? '选择仅用于管理此账户；查询时可让 Bot 按账户名称选择。默认账户不会自动切换。' : 'Selection manages this account only. Ask the Bot to choose an account by name for queries. The default does not change automatically.'}</p>
    </div> : null}
    {!busy && (ready || status?.accounts?.length) ? <button type="button" className="ob-btn ob-btn-sm ob-apps-configure" onClick={() => { setError(''); authorize(false, { addAccount: true }) }}>{zh ? '添加其他账号' : 'Add another account'}</button> : null}
    {removing ? <div className="ob-apps-git ob-apps-google">
      <p className="ob-hint">{zh ? `移除此账户的本机授权${removeAccountId ? `（${status?.accounts?.find(account => account.id === removeAccountId)?.label ?? ''}）` : '（默认账户）'}，保留其他账户。不会撤销 Google 中的授权；已发出的请求可能仍会完成。` : 'Removes this account locally, preserving the other accounts. Google consent is not revoked; submitted requests may still complete.'}</p>
      <button type="button" className="ob-btn ob-btn-sm" disabled={busy} onClick={() => { setBusy(true); setDisconnecting(true); void window.openbot.apps.disconnectGoogle(service, removeAccountId).then((result) => { if (result.ok) close(); else setError(zh ? '无法移除本机连接。' : 'Could not remove the local connection.') }).catch(() => setError(zh ? '无法移除本机连接。' : 'Could not remove the local connection.')).finally(() => { setBusy(false); setDisconnecting(false); refresh() }) }}>{zh ? '确认断开' : 'Disconnect'}</button>
      <button type="button" className="ob-btn ob-btn-sm" disabled={busy} onClick={() => setRemoving(false)}>{zh ? '取消' : 'Cancel'}</button>
    </div> : null}
    {!busy && !editing && status ? <button type="button" className="ob-btn ob-btn-sm ob-apps-configure" onClick={() => { setEditing(true); setError('') }}>{zh ? '高级：自带客户端…' : 'Advanced: bring your own client…'}</button> : null}
    {editing ? <Modal title={zh ? 'Google 连接设置' : 'Google connection settings'} onClose={() => setEditing(false)} size="md"><div className="ob-apps-git ob-apps-google">
      {error ? <p role="alert" className="ob-notice ob-notice-error">{error}</p> : null}
      <p className="ob-hint">{zh ? '高级配置：使用自己的 Google Cloud 桌面 OAuth 客户端并启用对应 API，或导入下载的桌面客户端 JSON。不是账号密码或 API key。' : 'Advanced: use your Google Cloud desktop OAuth client with the service API enabled, or import its downloaded JSON. This is not your password or an API key.'} <a href="https://developers.google.com/identity/protocols/oauth2/native-app" target="_blank" rel="noreferrer">{zh ? '配置说明' : 'Setup'}</a></p>
      <label className="ob-hint">{zh ? '导入桌面客户端 JSON' : 'Import desktop client JSON'}<input type="file" accept=".json,application/json" disabled={busy} onChange={(event) => {
        const file = event.target.files?.[0]; event.target.value = ''
        if (!file) return
        const version = ++importVersion.current
        setClientId(''); setSecret('')
        if (file.size > 64 * 1024) { setError(zh ? '客户端文件过大。' : 'Client file is too large.'); return }
        void file.text().then((text) => {
          if (version !== importVersion.current) return
          const value = JSON.parse(text)?.installed
          if (!value || typeof value.client_id !== 'string' || (value.client_secret !== undefined && typeof value.client_secret !== 'string')) throw new Error('Invalid desktop client')
          setClientId(value.client_id); setSecret(value.client_secret ?? ''); setError('')
        }).catch(() => { if (version === importVersion.current) setError(zh ? '请选择 Google 桌面应用的客户端 JSON。' : 'Choose a Google desktop app client JSON file.') })
      }} /></label>
      <input className="ob-input" aria-label="Google OAuth client ID" placeholder="Google OAuth client ID" value={clientId} autoComplete="off" onChange={(event) => setClientId(event.target.value)} disabled={busy} />
      <input className="ob-input" aria-label={zh ? '客户端密钥（可选）' : 'Client secret (optional)'} placeholder={zh ? '客户端密钥（可选）' : 'Client secret (optional)'} type="password" value={secret} autoComplete="off" onChange={(event) => setSecret(event.target.value)} disabled={busy} />
      <p className="ob-hint">{service === 'gmail' ? (zh ? '申请读取和发送邮件权限；公开分发可能需要 Google 审核。' : 'Requests mail read and send access; public distribution may require Google verification.') : (zh ? '申请读取和修改日历事件权限。' : 'Requests access to read and modify calendar events.')}</p>
      <button type="button" className="ob-btn ob-btn-sm" disabled={busy || !clientId.trim()} onClick={() => authorize(true)}>{zh ? '在浏览器中授权' : 'Authorize in browser'}</button>
      <button type="button" className="ob-btn ob-btn-sm" disabled={busy} onClick={close}>{zh ? '取消' : 'Cancel'}</button>
    </div></Modal> : null}
    {busy ? <p className="ob-hint ob-apps-connection-note" role="status">{disconnecting ? (zh ? '正在移除本机授权…' : 'Removing local credentials…') : (zh ? '请在浏览器完成授权或取消。' : 'Complete authorization in your browser or cancel.')}</p> : null}
    {error ? <p className="ob-notice ob-notice-error ob-apps-connection-note" role="alert">{error}</p> : null}
    {accessBot ? <BotAppAccess service={service} bot={accessBot} connected={status?.status === 'connected'} zh={zh} /> : null}
  </section>
}
