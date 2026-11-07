/** Main-process diagnostics only. The renderer keeps the pure pattern helper. */
import { diagnosticTail as patternTail, redactSecrets as patterns } from './secretRedaction'
import { scrubVaultTextNow } from '../store/vault'

export function redactSecrets(text: string): string {
  return patterns(scrubVaultTextNow(text).text)
}

export function diagnosticTail(text: string, maxChars = 1200): string {
  return patternTail(scrubVaultTextNow(text).text, maxChars)
}
