import { useState } from 'react'
import type { Bot } from '../../../shared/types'
import { CONNECTED_APP_TOOLS, type ConnectedApp } from '../../../shared/connectedAppTools'
import { loadBots } from '../state'

/** A service-level choice, with the same Bot identity inherited by its Agent. */
export function BotAppAccess({ service, bot, connected, zh }: { service: ConnectedApp; bot?: Bot; connected: boolean; zh: boolean }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const enabled = !!bot && CONNECTED_APP_TOOLS[service].every(id => bot.tools.includes(id))
  const remote = window.openbot?.environment?.kind === 'browser'
  const change = async () => {
    if (!bot || busy) return
    setBusy(true); setError('')
    try {
      const result = await window.openbot.apps.setBotAccess(service, bot.id, !enabled)
      if (!result.ok) setError(result.error ?? (zh ? '权限未保存，请重试。' : 'Access was not saved. Try again.'))
      await loadBots()
    } catch { setError(zh ? '权限未保存，请重试。' : 'Access was not saved. Try again.') }
    finally { setBusy(false) }
  }
  return <div className="ob-apps-connection-note" data-app-bot-access={service}>
    <p className="ob-hint">{bot ? enabled ? `${bot.name}${zh ? ' 及其 Agent 已获此应用的读取／本地草稿工具权限。' : ' and its Agent have access to this app’s reading/local draft tools.'}` : `${zh ? '连接后允许 ' : 'After connecting, allow '}${bot.name}${zh ? ' 及其 Agent 使用。' : ' and its Agent to use this app.'}` : zh ? '先选择一个 Bot，连接后即可允许它和执行 Agent 使用。' : 'Choose a Bot to allow it and its execution Agent after connecting.'}</p>
    {remote ? <p className="ob-hint">{zh ? '在 Mac 设置此应用的 Bot 使用权限。' : 'Manage this app’s Bot access on the Mac.'}</p> : <button type="button" className="ob-btn ob-btn-sm" disabled={!bot || busy || !enabled && !connected} onClick={() => void change()}>{busy ? (zh ? '正在保存…' : 'Saving…') : enabled ? (zh ? '撤销此 Bot 权限' : 'Revoke Bot access') : (zh ? '允许此 Bot 使用' : 'Allow this Bot')}</button>}
    {error ? <p role="alert" className="ob-notice ob-notice-error">{error}</p> : null}
  </div>
}
