import { setTimeout as delay } from 'node:timers/promises'
export async function connectPreview(child, port, type, readLogs) {
  let target
  for (let i = 0; i < 300; i++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Preview exited: ' + readLogs().slice(-1000))
    try { target = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find(value => !type || value.type === type); if (target) break } catch {}
    await delay(100)
  }
  if (!target) throw new Error('No Preview debugger')
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  let sequence = 0
  const pending = new Map()
  socket.onmessage = event => {
    const value = JSON.parse(event.data), item = pending.get(value.id)
    if (item) { pending.delete(value.id); clearTimeout(item.timer); value.error ? item.reject(new Error(JSON.stringify(value.error))) : item.resolve(value.result) }
  }
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('Debugger timed out: ' + method)) }, 20000)
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const value = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails))
    return value.result.value
  }
  return { send, evaluate, close: () => socket.close() }
}
