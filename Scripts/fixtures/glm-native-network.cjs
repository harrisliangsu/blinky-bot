// Metadata-only observation of the native Node HTTP client. No request mutation.
const dc = require('node:diagnostics_channel')
const fs = require('node:fs')
const output = process.env.BLINKY_GLM_NETWORK_TRACE
const started = Date.now()
const ids = new WeakMap()
const denials = new WeakMap()
let sequence = 0
const id = request => { if (!request || typeof request !== 'object') return 0; if (!ids.has(request)) ids.set(request, ++sequence); return ids.get(request) }
const record = value => { if (output) fs.appendFileSync(output, JSON.stringify({ at: Date.now(), elapsedMs: Date.now() - started, pid: process.pid, ...value }) + '\n', { mode: 0o600 }) }
const header = (headers, name) => {
  if (typeof headers === 'string') {
    const line = headers.split('\r\n').find(line => line.slice(0, line.indexOf(':')).toLowerCase() === name)
    return line?.slice(line.indexOf(':') + 1).trim()
  }
  if (Array.isArray(headers)) for (let i = 0; i < headers.length - 1; i += 2) if (String(headers[i]).toLowerCase() === name) return String(headers[i + 1])
}
record({ event: 'preload', node: process.versions.node, systemCaEnabled: process.env.NODE_USE_SYSTEM_CA === '1', tlsVerificationDisabled: process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0', proxyEnvNames: ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'].filter(key => Boolean(process.env[key])), customCaEnvNames: ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'].filter(key => Boolean(process.env[key])) })
if (process.env.BLINKY_GLM_TLS_PROBE_URL) {
  const url = new URL(process.env.BLINKY_GLM_TLS_PROBE_URL)
  if (url.protocol !== 'https:' || url.username || url.password || url.search) throw Error('Invalid TLS-only probe target')
  fetch(url, { method: 'GET', signal: AbortSignal.timeout(10000) }).then(response => {
    record({ event: 'tls-probe', status: response.status, credentialsSent: false }); return response.body?.cancel()
  }).catch(error => record({ event: 'tls-probe', name: error.name, code: error.code, causeCode: error.cause?.code, credentialsSent: false }))
}
dc.channel('undici:request:create').subscribe(({ request }) => {
  const auth = header(request.headers, 'authorization')
  record({ event: 'request', id: id(request), origin: new URL(String(request.origin)).origin, path: request.path?.split('?')[0], method: request.method,
    configuredCredentialUsed: process.env.BLINKY_PLANNING_PROVIDER_KEY ? auth === 'Bearer ' + process.env.BLINKY_PLANNING_PROVIDER_KEY.trim() : undefined,
    acceptEncoding: header(request.headers, 'accept-encoding') })
})
dc.channel('undici:request:headers').subscribe(({ request, response }) => {
  if (response.statusCode >= 400) denials.set(request, '')
  const marker = header(response.headers, 'x-mitmproxy-blocked-reason')
  record({ event: 'headers', id: id(request), status: response.statusCode, contentType: header(response.headers, 'content-type'), contentEncoding: header(response.headers, 'content-encoding'), transferEncoding: header(response.headers, 'transfer-encoding'), ...(marker && /^[A-Z_]{1,40}$/.test(marker) ? { intermediaryDenial: marker } : {}) })
})
dc.channel('undici:request:bodyChunkReceived').subscribe(({ request, chunk }) => {
  if (denials.has(request)) denials.set(request, (denials.get(request) + Buffer.from(chunk).toString('utf8')).slice(0, 2048))
})
dc.channel('undici:request:bodySent').subscribe(({ request }) => record({ event: 'body-sent', id: id(request) }))
dc.channel('undici:request:trailers').subscribe(({ request }) => {
  record({ event: 'complete', id: id(request) })
  if (denials.has(request)) {
    const text = denials.get(request)
    record({ event: 'denial-classification', id: id(request), bytesInspected: Buffer.byteLength(text), networkPolicy: /(?:blocked|denied|forbidden).{0,80}(?:policy|network)|(?:policy|network).{0,80}(?:blocked|denied|forbidden)/i.test(text), robots: /robots/i.test(text), intermediary: /mitmproxy|egress proxy|proxy.{0,30}(?:deny|block|auth)/i.test(text), credentials: /api.?key|unauthori[sz]ed|authentication|认证|鉴权/i.test(text), httpsOnly: /only https|https.{0,30}required/i.test(text), waf: /cloudflare|captcha|firewall/i.test(text) })
    if (process.env.BLINKY_GLM_TLS_PROBE_URL && request.method === 'GET' && !header(request.headers, 'authorization')) {
      record({ event: 'no-auth-public-denial', id: id(request), text: text.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[address]').replace(/[A-Za-z0-9+/_=-]{24,}/g, '[identifier]').slice(0, 1000) })
    }
    denials.delete(request)
  }
})
dc.channel('undici:request:error').subscribe(({ request, error }) => record({ event: 'error', id: id(request), code: error.code, name: error.name, causeCode: error.cause?.code }))
