import { Modal } from './Modal'
import { useEffect, useState, type ReactNode } from 'react'
import type { AppStatus } from '../../../shared/apps'
import type { Bot } from '../../../shared/types'
import { settingsCopy } from '../lib/settingsCopy'
import { AppBotAccessList } from './AppBotAccessList'

export function GitHubConnectCard({ zh, status, statusLabel, refresh, accessBot, bots }: { zh: boolean; status?: AppStatus; statusLabel: string; refresh: () => void; accessBot?: Bot; bots?: Bot[] }): ReactNode {
  const copy = settingsCopy(zh ? 'zh-CN' : 'en').apps
  const [editing, setEditing] = useState(false), [clientId, setClientId] = useState(''), [secret, setSecret] = useState(''), [busy, setBusy] = useState(false), [removing, setRemoving] = useState(false), [error, setError] = useState('')
  const [disconnecting, setDisconnecting] = useState(false)
  const ready = status?.detail === 'oauth-ready' || status?.detail === 'legacy-gh-auth' || status?.detail === 'verification-failed-with-client' || status?.status === 'connected'
  const close = (): void => { setEditing(false); setClientId(''); setSecret(''); setRemoving(false); setError('') }
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') { void window.openbot.apps.cancelGitHub(); close() } }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [])
  const authorize = (manual = false): void => {
    const inputSecret = secret
    setSecret(''); setBusy(true); setError('')
    const connection = accessBot ? window.openbot.apps.connectGitHub(manual ? clientId : '', manual ? inputSecret : '', accessBot.id) : window.openbot.apps.connectGitHub(manual ? clientId : '', manual ? inputSecret : '')
    void connection.then((result) => {
      if (result.ok) close()
      else setError(result.error || copy.githubLoginFailed)
    }).catch(() => setError(copy.githubLoginFailed)).finally(() => { setBusy(false); refresh() })
  }
  return <section className="ob-app-card" data-app="github">
    <div className="ob-app-icon" aria-hidden="true">GH</div>
    <div className="ob-app-summary"><h3>{copy.githubTitle}</h3>
      <p className="ob-set-value">{statusLabel}{status?.account ? ` · ${status.account}` : ''}</p>
      <p className="ob-hint">{copy.githubHint}</p>
      {status?.detail === 'oauth-client-required' ? <p className="ob-hint" role="status">{copy.githubMissing}</p> : null}
      {status?.detail?.startsWith('verification-failed') ? <p className="ob-hint">{zh ? '无法验证连接，请检查授权和网络。' : 'Could not verify the connection. Check authorization and the network.'}</p> : null}
    </div>
    <div className="ob-apps-google-actions">
      {busy ? <button type="button" className="ob-btn ob-btn-sm" disabled={disconnecting} onClick={() => void window.openbot.apps.cancelGitHub()}>{disconnecting ? (zh ? '正在断开…' : 'Disconnecting…') : (zh ? '取消' : 'Cancel')}</button> : <>
        <button type="button" className="ob-btn ob-btn-sm ob-btn-primary" data-connect="github" disabled={!status || !ready} onClick={() => { setError(''); if (ready) authorize() }}>{status?.status === 'connected' ? (zh ? '重新授权' : 'Reconnect') : (zh ? '连接' : 'Connect')}</button>
        {status?.status === 'connected' || status?.status === 'unavailable' ? <button type="button" className="ob-btn ob-btn-sm" onClick={() => setRemoving(true)}>{zh ? '断开' : 'Disconnect'}</button> : null}
      </>}
    </div>
    {removing ? <div className="ob-apps-git ob-apps-google">
      <p className="ob-hint">{zh ? '删除 BlinkyBot 保存的 GitHub 令牌。不会退出 gh 或 github.com，已发出的请求可能仍会完成。' : 'Removes the GitHub token saved by BlinkyBot. This does not sign you out of gh or github.com, and a request already sent may still complete.'}</p>
      <button type="button" className="ob-btn ob-btn-sm" disabled={busy} onClick={() => { setBusy(true); setDisconnecting(true); void window.openbot.apps.disconnectGitHub().then((result) => { if (result.ok) close(); else setError(zh ? '无法断开 GitHub。' : 'Could not disconnect GitHub.') }).catch(() => setError(zh ? '无法断开 GitHub。' : 'Could not disconnect GitHub.')).finally(() => { setBusy(false); setDisconnecting(false); refresh() }) }}>{zh ? '确认断开' : 'Disconnect'}</button>
      <button type="button" className="ob-btn ob-btn-sm" disabled={busy} onClick={() => setRemoving(false)}>{zh ? '取消' : 'Cancel'}</button>
    </div> : null}
    {status?.status !== 'connected' ? <p className="ob-hint ob-apps-connection-note">{copy.githubLegacy}</p> : null}
    {!busy && !editing && status ? <button type="button" className="ob-btn ob-btn-sm ob-apps-configure" onClick={() => { setEditing(true); setError('') }}>{zh ? '高级：自带客户端…' : 'Advanced: bring your own client…'}</button> : null}
    {editing ? <Modal title={zh ? 'GitHub 连接设置' : 'GitHub connection settings'} onClose={() => setEditing(false)} size="md"><div className="ob-apps-git ob-apps-google">
      {error ? <p role="alert" className="ob-notice ob-notice-error">{error}</p> : null}
      <p className="ob-hint">{zh ? '高级配置：使用自己的 GitHub App 客户端。登记下方精确回调，仓库权限只开 Issues 读写，并填写 Client ID 与 Client Secret。Secret 会随桌面应用分发，不是服务端机密；浏览器中仍需用户授权。' : 'Advanced: use your own GitHub App client. Register the exact callback below, enable only Issues read and write, and enter the client ID and client secret. The secret ships with the desktop app and is not a server secret; browser consent is still required.'} <a href="https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app" target="_blank" rel="noreferrer">{zh ? '配置说明' : 'Setup'}</a></p>
      <p className="ob-hint">{zh ? '回调地址' : 'Callback URL'}：<code>http://127.0.0.1:47841/oauth/github/callback</code></p>
      <input className="ob-input" aria-label="GitHub OAuth client ID" placeholder="GitHub OAuth client ID" value={clientId} autoComplete="off" onChange={(event) => setClientId(event.target.value)} disabled={busy} />
      <input className="ob-input" aria-label={zh ? '客户端密钥' : 'Client secret'} placeholder={zh ? '客户端密钥' : 'Client secret'} type="password" value={secret} autoComplete="off" onChange={(event) => setSecret(event.target.value)} disabled={busy} />
      <button type="button" className="ob-btn ob-btn-sm" disabled={busy || !clientId.trim() || !secret.trim()} onClick={() => authorize(true)}>{zh ? '在浏览器中授权' : 'Authorize in browser'}</button>
      <button type="button" className="ob-btn ob-btn-sm" disabled={busy} onClick={close}>{zh ? '取消' : 'Cancel'}</button>
    </div></Modal> : null}
    {busy ? <p className="ob-hint ob-apps-connection-note" role="status">{disconnecting ? (zh ? '正在移除本机授权…' : 'Removing local credentials…') : (zh ? '请在浏览器完成授权或取消。' : 'Complete authorization in your browser or cancel.')}</p> : null}
    {error ? <p className="ob-notice ob-notice-error ob-apps-connection-note" role="alert">{error}</p> : null}
    <AppBotAccessList service="github" bots={bots} accessBot={accessBot} connected={status?.status === 'connected'} zh={zh} />
  </section>
}
