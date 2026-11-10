export type VaultKind = 'login' | 'card' | 'address'

/** Metadata is safe to display; secret values never appear in this type. */
export interface VaultItem {
  id: string
  kind: VaultKind
  label: string
  origin?: string
  fields: string[]
  createdAt: number
}

export interface VaultInput {
  kind: VaultKind
  label: string
  origin?: string
  values: Record<string, string>
}

export type VaultResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** Empty replacement fields keep their encrypted values; values are never returned. */
export interface VaultUpdate { label: string; origin?: string; values?: Record<string, string> }
