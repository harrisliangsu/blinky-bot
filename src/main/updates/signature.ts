/**
 * Sparkle 2 signs the zip with Ed25519. `SUPublicEDKey` is the raw 32-byte
 * public key, and `sparkle:edSignature` is the raw 64-byte signature, both
 * standard base64. The signed bytes are the archive itself.
 */

import nacl from 'tweetnacl'

/** The key in `Scripts/sparkle-public-key.txt` and `SUPublicEDKey`. Do not rotate it. */
export const SPARKLE_PUBLIC_KEY = 'M/xUmNfKp+sEloy822L8X4lVdOLM1pv9srD7fw/bgb8='

export function decodeBase64(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return null
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64').replace(/=+$/g, '') !== value.replace(/=+$/g, '')) return null
  return new Uint8Array(bytes)
}

export function isEd25519PublicKey(value: string | null | undefined): boolean {
  return decodeBase64(value ?? '')?.length === 32
}

export function isEd25519Signature(value: string | null | undefined): boolean {
  return decodeBase64(value ?? '')?.length === 64
}

/** True only when the archive bytes match this signature and public key. */
export function verifySparkleSignature(archive: Uint8Array, signatureB64: string, publicKeyB64: string): boolean {
  const signature = decodeBase64(signatureB64)
  const publicKey = decodeBase64(publicKeyB64)
  if (!signature || signature.length !== 64 || !publicKey || publicKey.length !== 32) return false
  try {
    return nacl.sign.detached.verify(archive, signature, publicKey)
  } catch {
    return false
  }
}
