/**
 * Local CLIs the Add sheet can search. Each id matches a backend this build
 * can actually run. The keywords are how people look them up.
 */

export interface CliCatalogEntry {
  id: string
  label: string
  command: string
  keywords: string
  /** Models the CLI accepts besides "whatever the CLI itself is set to". */
  models?: readonly { id: string; label: string }[]
}

export const CLI_CATALOG: readonly CliCatalogEntry[] = [
  { id: 'codex', label: 'Codex', command: 'codex', keywords: 'codex openai gpt cli' },
  {
    id: 'claude',
    label: 'Claude Code',
    command: 'claude',
    keywords: 'claude code anthropic',
    models: [
      { id: 'opus', label: 'Opus' },
      { id: 'sonnet', label: 'Sonnet' },
      { id: 'haiku', label: 'Haiku' }
    ]
  },
  { id: 'kimi', label: 'Kimi Code', command: 'kimi', keywords: 'kimi kimi-code moonshot 月之暗面' },
  { id: 'grok', label: 'Grok', command: 'grok', keywords: 'grok xai' },
  { id: 'opencode', label: 'OpenCode', command: 'opencode', keywords: 'opencode sst' },
  { id: 'pi', label: 'Pi', command: 'pi', keywords: 'pi earendil' },
  { id: 'droid', label: 'Factory Droid', command: 'droid', keywords: 'droid factory' }
]

const BY_ID = new Map(CLI_CATALOG.map((entry) => [entry.id, entry]))

export function cliById(id: string): CliCatalogEntry | undefined {
  return BY_ID.get(id)
}
