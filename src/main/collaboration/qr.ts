import QRCode from './qr-encoder/index.cjs'
/** Encoded locally, with a four-module quiet zone. No network or process sees the invite. */
export async function invitationQr(invite: string): Promise<string> {
  if (!invite || invite.length > 512 || !/^[\x20-\x7e]+$/.test(invite)) throw new Error('Invalid invitation')
  const qr = new QRCode(-1, 0) // M error correction in the captured encoder.
  qr.addData(invite); qr.make()
  const count = qr.getModuleCount(), size = count + 8, cells: string[] = []
  for (let row = 0; row < count; row++) for (let col = 0; col < count; col++) if (qr.isDark(row, col)) cells.push(`M${col + 4} ${row + 4}h1v1h-1z`)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size * 8}" height="${size * 8}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white"/><path fill="black" d="${cells.join('')}"/></svg>`
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')
}
