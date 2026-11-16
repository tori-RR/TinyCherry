/** Product release DTOs. These do not install or execute an updater. */
export interface ProgressInfo {
  total: number
  delta: number
  transferred: number
  percent: number
  bytesPerSecond: number
}
export interface UpdateInfo {
  readonly version: string
  readonly files: Array<{
    url: string
    sha512: string
    size?: number
    blockMapSize?: number
    isAdminRightsRequired?: boolean
  }>
  readonly path: string
  readonly sha512: string
  releaseName?: string | null
  releaseNotes?: string | Array<{ version: string; note: string | null }> | null
  releaseDate: string
  readonly stagingPercentage?: number
  readonly minimumSystemVersion?: string
}
