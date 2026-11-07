import '../styles.css'
import '../controls.css'
import '../feedback.css'
import './remote.css'
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import App from '../App'
import { DeviceIdentity, RemoteHttpError } from './identity'
import { BrowserTransport } from './transport'

/** No application boot or workspace read happens before the host grants access. */
function RemoteRoot() {
  const [identity] = useState(() => { try { return new DeviceIdentity() } catch { return null } })
  const [name, setName] = useState(identity?.name ?? '')
  const [state, setState] = useState('idle')
  const [error, setError] = useState('')
  const [online, setOnline] = useState(true)
  const [needsHost, setNeedsHost] = useState(false)
  const [transport, setTransport] = useState<BrowserTransport | null>(null)
  const [checking, setChecking] = useState(Boolean(identity?.hasRequest()))
  useEffect(() => {
    // A new fragment belongs to a different invitation. Drop all private state,
    // pending callbacks and composer drafts by navigating a fresh document.
    const changed = () => location.reload()
    window.addEventListener('hashchange', changed)
    return () => window.removeEventListener('hashchange', changed)
  }, [])
  useEffect(() => {
    if (!identity || !checking || transport) return
    let active = true, timer: ReturnType<typeof setTimeout> | undefined
    const check = async () => {
      try {
        const result = await identity.check(true)
        if (!active) return
        setError(''); setState(result.state)
        if (result.access) {
          const next = new BrowserTransport(identity, result.access, setOnline, () => {
            // A new document also cancels in-flight boot/load promises: they
            // cannot repopulate private state after revocation.
            location.reload()
          })
          window.openbot = next.api; setTransport(next); setChecking(false); return
        }
        if (result.state !== 'pending') { setChecking(false); return }
      } catch (e) {
        if (!active) return
        setError(e instanceof Error ? e.message : '无法连接主机。 / Cannot reach the Mac.')
        if (e instanceof RemoteHttpError && [401, 403, 404].includes(e.status)) { setState('expired'); setChecking(false); return }
      }
      timer = setTimeout(() => void check(), 1500)
    }
    void check()
    return () => { active = false; clearTimeout(timer) }
  }, [identity, checking, transport])
  useEffect(() => () => transport?.stop(), [transport])
  useEffect(() => { const update = (event: Event) => setNeedsHost((event as CustomEvent<boolean>).detail); window.addEventListener('blinky:remote-needs-host', update); return () => window.removeEventListener('blinky:remote-needs-host', update) }, [])
  if (transport) return <><div className="ob-remote-status" role="status">{online ? needsHost ? '当前对话需要在 Mac 确认，请回到主机处理。' : `已获 Mac 批准 · ${transport.api.environment?.permission === 'view' ? '只读' : '可操作'} · ${transport.api.environment?.scope === 'workspace' ? '整个工作区' : '指定会话'}` : '连接中断，正在自动重连。输入草稿保留在本页。'}<span>系统授权、凭据、账号登录和本机设备操作请在 Mac 完成。</span></div><App /></>
  const request = async () => {
    if (!identity) return
    setError(''); setState('requesting')
    try { await identity.request(name); setState('pending'); setChecking(true) }
    catch (e) { setState('idle'); setError(e instanceof Error ? e.message : '连接请求失败。') }
  }
  const labels: Record<string, string> = { pending: '等待 Mac 主机明确批准。批准前无法读取聊天或工作区。', denied: '主机已拒绝此设备。请在 Mac 处理，重新打开链接不会绕过拒绝。', revoked: '主机已撤销此设备，访问已停止。', expired: '访问已过期，请重新请求主机批准。' }
  return <main className="ob-remote-connect"><h1>BlinkyBot Remote</h1><p>确认设备名称，然后在 Mac 允许连接。</p>{!identity ? <p role="alert">邀请不完整，请从 Mac 重新复制。</p> : <><label>设备名称<input autoComplete="off" value={name} onChange={e => setName(e.target.value)} maxLength={80} disabled={checking} /></label><details className="ob-remote-key"><summary>设备编号 {identity.fingerprint.slice(0, 8)}</summary><code>{identity.fingerprint.match(/.{1,8}/g)?.join(' ')}</code></details><p>{labels[state]}</p>{identity.legacy ? <p>这是旧版邀请，仍需主机重新批准。建议从 Mac 复制带主机指纹的新邀请。</p> : null}<button className="ob-btn ob-btn-primary" onClick={() => void request()} disabled={checking || state === 'requesting' || state === 'denied' || state === 'revoked' || !name.trim()}>连接</button></>}{error ? <p role="alert">{error}</p> : null}<p>请仅在信任的局域网使用。连接不提供 HTTPS 加密；邀请和指纹应通过可信渠道取得。</p></main>
}
createRoot(document.getElementById('root')!).render(<RemoteRoot />)
