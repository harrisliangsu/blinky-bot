/**
 * Files that name extra bin directories. Kept off `which.ts` so the lookup
 * and the startup adoption pass do not import each other.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Installed nvm Node versions (`v22.12.0`, …), or an empty list. */
export async function installedNvmVersions(home: string): Promise<string[]> {
  try {
    return await readdir(join(home, '.nvm', 'versions', 'node'))
  } catch {
    return []
  }
}

/** `~/.npmrc`, or undefined when the user has not set one. */
export async function readUserNpmrc(home: string): Promise<string | undefined> {
  try {
    return await readFile(join(home, '.npmrc'), 'utf8')
  } catch {
    return undefined
  }
}
