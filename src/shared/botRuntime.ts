/**
 * Which local CLI or provider a Bot is aimed at, and which models that
 * choice can offer. The picker only lists installed, usable CLIs and
 * providers the user has added — `listedBackends` owns that filter.
 */

import type { BackendKind } from './backends'
import { cliById } from './cliCatalog'

export type RuntimeSource = 'cli' | 'provider'

export function runtimeSource(backendId: string, kind?: BackendKind): RuntimeSource {
  if (kind) return kind === 'agent-cli' ? 'cli' : 'provider'
  return cliById(backendId) ? 'cli' : 'provider'
}

export interface RuntimeModel {
  id: string
  label: string
}

/**
 * Models for one CLI or provider.
 *
 * `default` means "whatever this CLI or provider is set to". A CLI catalog
 * may name a few aliases (Claude's opus / sonnet / haiku). Detected rows
 * fill the rest. The saved id stays visible even when the catalog has not
 * loaded yet.
 */
export function runtimeModels(
  backendId: string,
  detected: readonly RuntimeModel[],
  selected: string
): RuntimeModel[] {
  const seen = new Set<string>()
  const out: RuntimeModel[] = []
  const add = (id: string, label: string): void => {
    const trimmed = id.trim()
    if (!trimmed || seen.has(trimmed)) return
    seen.add(trimmed)
    out.push({ id: trimmed, label: label.trim() || trimmed })
  }
  add('default', 'default')
  for (const model of cliById(backendId)?.models ?? []) add(model.id, model.label)
  for (const model of detected) add(model.id, model.label)
  if (selected) add(selected, selected)
  return out
}
