/** Result of Settings → Updates → Check now. */
export interface UpdateReport {
  channel: 'stable' | 'beta'
  current: string
  latest: string | null
  url: string | null
  updateAvailable: boolean
  note: string
  /** Why the check stopped. The settings row uses this instead of the English note. */
  status: 'update' | 'current' | 'empty' | 'error'
  /** A signed BlinkyBot zip from this repository's GitHub releases. */
  installable: boolean
}
