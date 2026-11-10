declare class QRCode {
  constructor(version: number, errorCorrection: number)
  addData(value: string): void
  make(): void
  getModuleCount(): number
  isDark(row: number, col: number): boolean
}
export = QRCode
