/** The local speech helper is a packaged build input, not a runtime compiler. */
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
if (process.platform === 'darwin') {
  mkdirSync('out/native', { recursive: true })
  const result = spawnSync('xcrun', ['swiftc', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx14.0`, '-O', '-swift-version', '5', '-framework', 'Speech', '-framework', 'AVFoundation', 'src/main/speech/BlinkySpeech.swift', '-o', 'out/native/BlinkySpeech'], { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
