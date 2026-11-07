/**
 * Redaction for anything we surface from a child process.
 *
 * Agent CLIs echo their own configuration on failure, which routinely includes
 * API keys. Diagnostics are only useful if they are safe to show and log.
 */

const PATTERNS: Array<[RegExp, string]> = [
  [/\b(sk-or-v1-[A-Za-z0-9_-]{6,})/g, 'sk-or-v1-***'],
  [/\b(sk-ant-[A-Za-z0-9_-]{6,})/g, 'sk-ant-***'],
  [/\b(sk-proj-[A-Za-z0-9_-]{6,})/g, 'sk-proj-***'],
  [/\b(sk-[A-Za-z0-9_-]{16,})/g, 'sk-***'],
  [/\b(xai-[A-Za-z0-9_-]{8,})/g, 'xai-***'],
  [/\b(gh[pousr]_[A-Za-z0-9]{16,})/g, 'gh*_***'],
  [/\b(AIza[A-Za-z0-9_-]{10,})/g, 'AIza***'],
  [/\b(ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{4,})/g, '<jwt>'],
  [/(bearer\s+)([A-Za-z0-9._-]{12,})/gi, '$1***'],
  [/(("|')?(api[_-]?key|access[_-]?token|secret|password)("|')?\s*[:=]\s*("|')?)([^\s"',}]{6,})/gi, '$1***']
]

export function redactSecrets(text: string): string {
  let out = text
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement)
  return out
}

/** Shared public prose policy for Agent records and remote workspace data. */
export function redactPrivateText(text: string): string {
  return redactSecrets(text)
    .replace(/\bxox(?:[baprs]-|e\.xox[baprs]-)[A-Za-z0-9-]{8,}/g, '[redacted Slack token]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted private key]')
    .replace(/((?:authorization|cookie|set-cookie)\s*:\s*)[^\r\n]+/gi, '$1[redacted]')
    .replace(/((?:authorization|cookie|password|passphrase|secret|token|api[_-]?key|credential|密码|密钥|令牌)[\w.-]*["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}\n]+)/gi, '$1[redacted]')
}

/** Redacted, length-capped diagnostics for a failed subprocess. */
export function diagnosticTail(text: string, maxChars = 1200): string {
  const redacted = redactSecrets(text).trim()
  return redacted.length > maxChars ? `…${redacted.slice(-maxChars)}` : redacted
}
