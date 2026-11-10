/** Metadata-only recursive observation. No file contents or symlink targets are read. */
import { createHash } from 'node:crypto'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { Settings } from '../../shared/types'
import { deniedRuleForCall, evaluate } from '../agent/approvalPolicy'
import { localExecutionPolicy, LOCAL_EXECUTION_REFUSAL } from '../../shared/localExecution'

export interface FolderWatchOptions {
  settings?: Settings
  getSettings?: () => Settings
  maxEntries?: number
  maxDepth?: number
}

export function assertFolderObservationAllowed(path: string, settings?: Settings): void {
  if (!settings) return
  if (localExecutionPolicy(settings) === 'never-allow') throw new Error(LOCAL_EXECUTION_REFUSAL)
  for (const name of ['watch_folder', 'list_dir', 'read_file']) {
    const call = { id: 'folder-observation', name, args: { path } }
    if (deniedRuleForCall(settings, call)) {
      throw new Error('文件夹观察被当前目录或工具限制拒绝。')
    }
    if (evaluate(settings, name, path, new Set(), false, false, true, call).outcome === 'ask') {
      throw new Error('目录观察需要人工确认，后台扫描已暂停。 / Folder observation requires a user decision; unattended scans are paused.')
    }
  }
}

/** Creation can resolve an authorized alias once; subsequent scans stay pinned. */
export async function canonicalFolder(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new TypeError('文件夹需要绝对路径。')
  const canonical = await realpath(path)
  if (!(await lstat(canonical)).isDirectory()) throw new TypeError('所选路径不是文件夹。')
  return canonical
}

export async function folderMetadataFingerprint(path: string, options: FolderWatchOptions = {}): Promise<string> {
  const settings = (): Settings | undefined => options.getSettings?.() ?? options.settings
  const root = resolve(path)
  assertFolderObservationAllowed(root, settings())
  if (!isAbsolute(path) || await realpath(root) !== root) throw new Error('文件夹的物理路径已改变，未跟随新的符号链接。')
  const maxEntries = options.maxEntries ?? 20_000, maxDepth = options.maxDepth ?? 64
  let entries = 0
  const hash = createHash('sha256')
  const metadata = (value: Awaited<ReturnType<typeof lstat>>) => [String(value.dev), String(value.ino), String(value.mode), String(value.size), String(value.mtimeMs), String(value.ctimeMs)]
  async function walk(directory: string, relative: string, depth: number): Promise<void> {
    if (depth > maxDepth) throw new Error(`文件夹观察超过 ${maxDepth} 层，未把不完整扫描当作没有变化。`)
    assertFolderObservationAllowed(directory, settings())
    const before = await lstat(directory)
    if (!before.isDirectory() || before.isSymbolicLink() || await realpath(directory) !== directory) throw new Error('扫描中的目录路径已改变，未跟随符号链接。')
    if (!relative) hash.update(JSON.stringify(['.', ...metadata(before)]) + '\n')
    const names = (await readdir(directory)).sort()
    for (const name of names) {
      if (++entries > maxEntries) throw new Error(`文件夹观察超过 ${maxEntries} 项，未把不完整扫描当作没有变化。`)
      const target = join(directory, name), rel = relative ? `${relative}/${name}` : name
      assertFolderObservationAllowed(target, settings())
      const item = await lstat(target)
      hash.update(JSON.stringify([rel, ...metadata(item)]) + '\n')
      if (item.isDirectory() && !item.isSymbolicLink()) await walk(target, rel, depth + 1)
    }
    const after = await lstat(directory)
    if (!after.isDirectory() || after.isSymbolicLink() || metadata(before).join('|') !== metadata(after).join('|')) {
      throw new Error('扫描期间文件夹发生变化，本次结果未作为完整指纹保存。')
    }
  }
  await walk(root, '', 0)
  assertFolderObservationAllowed(root, settings())
  if (await realpath(root) !== root) throw new Error('文件夹物理路径在扫描期间改变。')
  return hash.digest('hex')
}
