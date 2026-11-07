/**
 * Parse a Codex `model/list` page.
 *
 * Kept apart from the app-server process so tests can read the catalog
 * without loading the JSON-RPC peer (parameter properties the strip-only
 * test runner rejects).
 */

import type { ModelInfo } from '../types'
import { isThinkingDepth, type ThinkingDepth } from '../../../shared/thinking'

/** Ids Settings will actually store. Anything else cannot be selected. */
const MODEL_ID = /^[A-Za-z0-9._:@/-]{1,120}$/

export interface CodexModelPage {
  models: ModelInfo[]
  nextCursor: string | null
}

function textField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function oneModel(entry: unknown): ModelInfo | null {
  if (!entry || typeof entry !== 'object') return null
  const row = entry as Record<string, unknown>
  if (row['hidden'] === true) return null
  const id = textField(row['model']) || textField(row['id'])
  if (!id || id === 'default' || !MODEL_ID.test(id)) return null
  const label = textField(row['displayName']) || textField(row['name']) || id
  /*
   * Older catalogs omit `inputModalities`. Codex documents that absence as
   * text and image, so a missing field must not hide vision from the picker.
   */
  const listed = Array.isArray(row['inputModalities'])
    ? row['inputModalities'].filter((item): item is string => typeof item === 'string')
    : null
  const efforts = Array.isArray(row['supportedReasoningEfforts'])
    ? [...new Set(row['supportedReasoningEfforts'].flatMap((entry): ThinkingDepth[] => {
        if (!entry || typeof entry !== 'object') return []
        const raw = (entry as Record<string, unknown>)['reasoningEffort']
        const depth = raw === 'none' ? 'off' : raw
        return isThinkingDepth(depth) ? [depth] : []
      }))]
    : undefined
  return {
    id,
    label: label.slice(0, 120),
    supportsTools: true,
    supportsVision: listed === null ? true : listed.includes('image'),
    ...(row['isDefault'] === true ? { isDefault: true } : {}),
    ...(efforts !== undefined ? { supportedThinking: efforts } : {})
  }
}

/** One `model/list` result. Unknown shapes yield no models and no cursor. */
export function parseCodexModelPage(result: unknown): CodexModelPage {
  const record =
    result && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>) : null
  const raw = Array.isArray(result)
    ? result
    : Array.isArray(record?.['data'])
      ? record['data']
      : Array.isArray(record?.['models'])
        ? record['models']
        : []
  const models: ModelInfo[] = []
  for (const entry of raw) {
    const model = oneModel(entry)
    if (model) models.push(model)
  }
  const cursor = textField(record?.['nextCursor'])
  return { models, nextCursor: cursor && cursor.length <= 512 && !cursor.includes('\n') ? cursor : null }
}
