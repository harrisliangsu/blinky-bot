/**
 * When a finished turn is allowed to spend a second model call on memory.
 *
 * `off` disables extraction, `api` limits it to the application tool loop,
 * and `all` also enables it for supervised CLI turns. The product default is
 * all; an explicit saved choice must survive settings normalization.
 */

import type { Settings } from '../../shared/types'
import type { TurnMode } from './backendMode'

export type MemoryExtraction = NonNullable<Settings['memoryExtraction']>

/** Product default for a missing preference. */
export const DEFAULT_MEMORY_EXTRACTION: MemoryExtraction = 'all'

export function extractionAllowed(settings: Settings, mode: TurnMode): boolean {
  const choice = settings.memoryExtraction ?? DEFAULT_MEMORY_EXTRACTION
  if (choice === 'off') return false
  return choice === 'all' || mode !== 'supervised'
}
