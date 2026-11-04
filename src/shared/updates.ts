/** Result of Settings → Updates → Check now. */
export interface UpdateReport {
  channel: 'stable' | 'beta'
  current: string
  latest: string | null
  url: string | null
  updateAvailable: boolean
  note: string
}
