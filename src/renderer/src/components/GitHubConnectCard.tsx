import { useEffect, useState, type ReactNode } from 'react'
import type { AppStatus } from '../../../shared/apps'
import { settingsCopy } from '../lib/settingsCopy'

export function GitHubConnectCard({ zh, status, statusLabel, refresh }: { zh: boolean; status?: AppStatus; statusLabel: string; refresh: () => void }): ReactNode {
  const copy = settingsCopy(zh ? 'zh-CN' : 'en').apps
  const [busy, setBusy] = useState(false), [removing, setRemoving] = useState(false), [error, setError] = useState('')
  const [disconnecting, setDisconnecting] = useState(false)
  const ready = status?.detail === 'oauth-ready' || status?.detail === 'legacy-gh-auth' || status?.detail === 'verification-failed-with-client' || status?.status === 'connected'
  const linked = status?.status === 'connected' || status?.status === 'unavailable'
  const close = (): void => { setRemoving(false); setError('') }
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') { void window.openbot.apps.cancelGitHub(); close() } }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [])
  const authorize = (): void => {
    setBusy(true); setError('')
    void window.openbot.apps.connectGitHub('', '').then((result) => {
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
        <button type="button" className="ob-btn ob-btn-sm ob-btn-primary" data-connect="github" disabled={!status || !ready} onClick={() => { setError(''); if (ready) authorize() }}>{linked ? (zh ? '重新授权' : 'Reconnect') : (zh ? '连接' : 'Connect')}</button>
        {linked ? <button type="button" className="ob-btn ob-btn-sm" onClick={() => setRemoving(true)}>{zh ? '断开' : 'Disconnect'}</button> : null}
      </>}
    </div>
    {removing ? <div className="ob-apps-git ob-apps-google">
      <p className="ob-hint">{zh ? '删除 BlinkyBot 保存的 GitHub 令牌。不会退出 gh 或 github.com，已发出的请求可能仍会完成。' : 'Removes the GitHub token saved by BlinkyBot. This does not sign you out of gh or github.com, and a request already sent may still complete.'}</p>
      <button type="button" className="ob-btn ob-btn-sm" disabled={busy} onClick={() => { setBusy(true); setDisconnecting(true); void window.openbot.apps.disconnectGitHub().then((result) => { if (result.ok) close(); else setError(zh ? '无法断开 GitHub。' : 'Could not disconnect GitHub.') }).catch(() => setError(zh ? '无法断开 GitHub。' : 'Could not disconnect GitHub.')).finally(() => { setBusy(false); setDisconnecting(false); refresh() }) }}>{zh ? '确认断开' : 'Disconnect'}</button>
      <button type="button" className="ob-btn ob-btn-sm" disabled={busy} onClick={() => setRemoving(false)}>{zh ? '取消' : 'Cancel'}</button>
    </div> : null}
    {status?.status !== 'connected' ? <p className="ob-hint ob-apps-connection-note">{copy.githubLegacy}</p> : null}
    {busy ? <p className="ob-hint ob-apps-connection-note" role="status">{disconnecting ? (zh ? '正在移除本机授权…' : 'Removing local credentials…') : (zh ? '请在浏览器完成授权或取消。' : 'Complete authorization in your browser or cancel.')}</p> : null}
    {error ? <p className="ob-notice ob-notice-error ob-apps-connection-note" role="alert">{error}</p> : null}
  </section>
}
