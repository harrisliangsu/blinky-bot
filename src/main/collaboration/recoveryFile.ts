/** OS-encrypted, owner-only and atomic. Consent changes must land before acknowledgement. */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
export interface RecoveryProtection { isEncryptionAvailable(): boolean; getSelectedStorageBackend?(): string; encryptString(value: string): Buffer; decryptString(value: Buffer): string }
export class RecoveryFile {
  constructor(private readonly file: string, private readonly protection: RecoveryProtection) {}
  private requireProtection(): void {
    if (!this.protection.isEncryptionAvailable() || this.protection.getSelectedStorageBackend?.() === 'basic_text') throw new Error('Secure storage is unavailable; sharing cannot be restored after restart.')
  }
  read(): unknown {
    let raw: string
    try { raw = readFileSync(this.file, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    this.requireProtection()
    const value = JSON.parse(raw)
    if (value?.version !== 1 || typeof value.ciphertext !== 'string' || value.ciphertext.length > 8 * 1024 * 1024) throw new Error('Saved sharing could not be verified.')
    return JSON.parse(this.protection.decryptString(Buffer.from(value.ciphertext, 'base64')))
  }
  write(value: unknown): void {
    this.requireProtection()
    const text = JSON.stringify({ version: 1, ciphertext: this.protection.encryptString(JSON.stringify(value)).toString('base64') })
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const temporary = this.file + '.' + process.pid + '.tmp'
    let fd: number | undefined
    try {
      fd = openSync(temporary, 'wx', 0o600); writeFileSync(fd, text); fsyncSync(fd); closeSync(fd); fd = undefined
      renameSync(temporary, this.file)
    } catch (error) { if (fd !== undefined) closeSync(fd); try { unlinkSync(temporary) } catch { /* retain the original */ }; throw error }
    // Directory fsync is unsupported on Windows. The replacement is already atomic.
    try { fd = openSync(dirname(this.file), 'r'); fsyncSync(fd) } catch { /* platform limitation */ } finally { if (fd !== undefined) closeSync(fd) }
  }
}
