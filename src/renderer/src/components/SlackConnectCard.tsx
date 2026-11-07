import { Modal } from './Modal'
import { useState, type ReactNode } from 'react'
import type { Bot } from '../../../shared/types'
import { BotAppAccess } from './BotAppAccess'

export type SlackView = { state: 'disconnected' | 'connecting' | 'connected' | 'error'; teamId?: string; channelId?: string; allowedUserId?: string; botId?: string; mode?: 'browser' | 'socket'; browserReady?: boolean }
export function slackChannelFromInput(input: string): string {
  const value = input.trim()
  if (/^[CGD][A-Z0-9]{2,30}$/.test(value)) return value
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || !(url.hostname === 'app.slack.com' || url.hostname.endsWith('.slack.com'))) return ''
    return /\/(?:archives\/|client\/T[A-Z0-9]+\/)([CGD][A-Z0-9]{2,30})(?:\/|$)/.exec(url.pathname)?.[1] ?? ''
  } catch { return '' }
}
export function SlackConnectCard({ zh, bots, status, statusLabel, refresh, accessBot }: { zh: boolean; bots: Bot[]; status?: SlackView; statusLabel?: string; refresh: () => void; accessBot?: Bot }): ReactNode {
  const [editing, setEditing] = useState(false), [mode, setMode] = useState<'browser'|'socket'>('browser')
  const [appToken, setAppToken] = useState(''), [botToken, setBotToken] = useState(''), [channel, setChannel] = useState(''), [userId, setUserId] = useState(''), [botId, setBotId] = useState('')
  const [busy, setBusy] = useState(false), [removingBusy, setRemovingBusy] = useState(false), [error, setError] = useState(''), [removing, setRemoving] = useState(false)
  const available = bots.filter((bot) => !bot.archived), selected = botId || status?.botId || available[0]?.id || '', channelId = slackChannelFromInput(channel)
  const label = statusLabel ?? (status?.state === 'connected' ? (zh ? '已连接' : 'Connected') : status?.state === 'connecting' ? (zh ? '正在核验…' : 'Checking…') : status?.state === 'error' ? (zh ? '连接不可用' : 'Connection unavailable') : (zh ? '未连接' : 'Not connected'))
  const edit = (): void => { setEditing(!editing); setMode(status?.mode ?? 'browser'); setChannel(status?.channelId ?? ''); setError('') }
  const connect = (): void => {
    const input = { appToken: mode === 'browser' ? '' : appToken, botToken: mode === 'browser' ? '' : botToken, channelId, allowedUserId: mode === 'browser' ? '' : userId, botId: selected, ...(accessBot ? { accessBotId: accessBot.id } : {}) }
    setAppToken(''); setBotToken(''); setBusy(true); setError('')
    void window.openbot.apps.connectSlack(input).then((result) => {
      if (result.ok) setEditing(false)
      else setError(result.error || (zh ? '连接未完成，请检查应用配置、工作区批准、频道权限或网络。' : 'Connection did not complete. Check app setup, workspace approval, channel access and the network.'))
    }).catch(() => setError(zh ? '连接未完成，请重试。' : 'Connection did not complete.')).finally(() => { setBusy(false); refresh() })
  }
  return <section className="ob-app-card" data-app="slack">
    <div className="ob-app-icon" aria-hidden="true">S</div><div className="ob-app-summary"><h3>Slack</h3><p className="ob-set-value">{label}{status?.teamId ? ` · ${status.teamId}` : ''}</p>
      {status?.channelId ? <p className="ob-hint">{status.channelId} · {status.allowedUserId}</p> : null}
      {status?.mode === 'browser' ? <p className="ob-hint">{zh ? '用户授权 · 草稿外发，不接收频道消息' : 'User authorization · drafts only, no incoming channel messages'}</p> : null}
    </div>
    <div className="ob-apps-google-actions">
      <button type="button" className="ob-btn ob-btn-sm" disabled={busy || removingBusy} onClick={edit}>{status?.teamId ? (zh ? '重新连接' : 'Reconnect') : (zh ? '连接' : 'Connect')}</button>
      {status?.teamId || busy ? <button type="button" className="ob-btn ob-btn-sm" disabled={removingBusy} onClick={() => setRemoving(true)}>{busy ? (zh ? '取消并断开…' : 'Cancel and disconnect…') : (zh ? '断开' : 'Disconnect')}</button> : null}
    </div>
    {removing ? <div className="ob-apps-git ob-apps-google">
      <p className="ob-hint">{zh ? '取消正在进行的授权并移除现有本机 Slack 连接。不会撤销 Slack 中的授权；已发出的请求可能仍会完成。' : 'Cancels pending authorization and removes the existing local Slack connection. Slack consent is not revoked; submitted requests may still complete.'}</p>
      <button type="button" className="ob-btn ob-btn-sm" disabled={removingBusy} onClick={() => {
        setRemovingBusy(true)
        void window.openbot.apps.disconnectSlack().then((result) => { if (result.ok) { setRemoving(false); setEditing(false) } else setError(zh ? '无法移除本机连接。' : 'Could not remove the local connection.') }).catch(() => setError(zh ? '无法移除本机连接。' : 'Could not remove the local connection.')).finally(() => { setRemovingBusy(false); refresh() })
      }}>{zh ? '确认断开' : 'Disconnect'}</button><button type="button" className="ob-btn ob-btn-sm" disabled={removingBusy} onClick={() => setRemoving(false)}>{zh ? '保留连接' : 'Keep connection'}</button>
    </div> : null}
    {editing ? <Modal title={zh ? 'Slack 连接设置' : 'Slack connection settings'} onClose={() => setEditing(false)} size="md"><div className="ob-apps-git ob-apps-google">
      {error ? <p role="alert" className="ob-notice ob-notice-error">{error}</p> : null}
      <div className="ob-apps-google-actions" role="group" aria-label={zh ? 'Slack 连接方式' : 'Slack connection mode'}>
        <button type="button" className="ob-btn ob-btn-sm" aria-pressed={mode === 'browser'} disabled={busy} onClick={() => setMode('browser')}>{zh ? '浏览器用户授权' : 'Browser user authorization'}</button>
        <button type="button" className="ob-btn ob-btn-sm" aria-pressed={mode === 'socket'} disabled={busy} onClick={() => setMode('socket')}>{zh ? '高级：Socket Mode' : 'Advanced: Socket Mode'}</button>
      </div>
      {mode === 'browser' ? <>
        <p className="ob-hint">{zh ? '在浏览器中选择工作区并授权。使用你的用户授权创建发送草稿；确认后才发送，不自动接收频道消息，也不需要填写令牌。' : 'Choose a workspace and authorize in your browser. Uses user authorization for reviewed message drafts; sends only after confirmation. No incoming messages or manual tokens.'}</p>
        {!status?.browserReady ? <p className="ob-hint">{zh ? '此发行版尚待开发者预置 Slack 公共客户端并完成分发设置，当前不能开始浏览器授权。' : 'The distributor must first configure a Slack public client and app distribution before browser authorization is available.'} <a href="https://docs.slack.dev/authentication/using-pkce/" target="_blank" rel="noreferrer">{zh ? '官方要求' : 'Official requirements'}</a></p> : null}
      </> : <>
        <p className="ob-hint">{zh ? '由管理员配置 Bot + Socket Mode，接收指定频道中指定用户的消息，回复仍先生成草稿。浏览器用户授权不能提供此接收能力。' : 'Administrator-configured Bot + Socket Mode receives messages from one selected user and channel; replies remain drafts first. Browser user authorization does not enable reception.'} <a href="https://docs.slack.dev/apis/events-api/using-socket-mode/" target="_blank" rel="noreferrer">{zh ? '配置说明' : 'Setup'}</a></p>
        <input className="ob-input" aria-label="Slack app token" placeholder="App token (xapp-…)" type="password" autoComplete="off" value={appToken} onChange={(event) => setAppToken(event.target.value)} disabled={busy} />
        <input className="ob-input" aria-label="Slack bot token" placeholder="Bot token (xoxb-…)" type="password" autoComplete="off" value={botToken} onChange={(event) => setBotToken(event.target.value)} disabled={busy} />
        <input className="ob-input" aria-label={zh ? '允许的 Slack 用户 ID' : 'Allowed Slack user ID'} placeholder={zh ? '允许的用户 ID' : 'Allowed user ID'} value={userId} onChange={(event) => setUserId(event.target.value)} disabled={busy} />
      </>}
      <input className="ob-input" aria-label={zh ? 'Slack 频道链接或 ID' : 'Slack channel link or ID'} placeholder={zh ? '粘贴 Slack 频道链接或 ID' : 'Paste a Slack channel link or ID'} value={channel} onChange={(event) => setChannel(event.target.value)} disabled={busy} />
      <select className="ob-select" aria-label={zh ? '使用连接的 Bot' : 'Bot using this connection'} value={selected} onChange={(event) => setBotId(event.target.value)} disabled={busy}>{available.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select>
      <button type="button" className="ob-btn ob-btn-sm" disabled={busy || !channelId || !selected || (mode === 'browser' ? !status?.browserReady : !appToken || !botToken || !userId)} onClick={connect}>{busy ? (zh ? '等待授权…' : 'Waiting for authorization…') : mode === 'browser' ? (zh ? '在浏览器中授权' : 'Authorize in browser') : (zh ? '验证并连接' : 'Verify and connect')}</button>
      <button type="button" className="ob-btn ob-btn-sm" disabled={busy} onClick={() => { setEditing(false); setAppToken(''); setBotToken(''); setError('') }}>{zh ? '关闭' : 'Close'}</button>
    </div></Modal> : null}
    {error ? <p className="ob-notice ob-notice-error ob-apps-connection-note" role="alert">{error}</p> : null}
    {accessBot ? <BotAppAccess service="slack" bot={accessBot} connected={status?.state === 'connected'} zh={zh} /> : null}
  </section>
}
