/** Host-owned dialog and event contracts; no runtime-specific namespace. */
export interface OpenDialogOptions {
  title?: string
  defaultPath?: string
  buttonLabel?: string
  filters?: ReadonlyArray<{ name: string; extensions: string[] }>
  properties?: Array<
    | 'openFile'
    | 'openDirectory'
    | 'multiSelections'
    | 'showHiddenFiles'
    | 'createDirectory'
    | 'promptToCreate'
    | 'noResolveAliases'
    | 'treatPackageAsDirectory'
    | 'dontAddToRecent'
  >
  message?: string
}
export interface OpenExternalOptions {
  activate?: boolean
  workingDirectory?: string
  logUsage?: boolean
}
export interface DesktopEvent {
  readonly source: 'host'
}
export type DesktopCapability =
  | 'chat'
  | 'knowledge'
  | 'prompts'
  | 'skills'
  | 'computerUse'
  | 'markdownPreview'
  | 'notifications'
  | 'archives'
  | 'agents'
  | 'mcp'
  | 'attachments'
  | 'backups'
  | 'browser'
  | 'painting'
  | 'translation'
  | 'downloads'
  | 'globalShortcuts'
  | 'extraWindows'
  | 'skillExecution'
export interface DesktopInfo {
  readonly platform: 'win32' | 'darwin' | 'linux'
  readonly arch: string
  readonly version: string
  readonly revision: string
  readonly protocol: number
  readonly capabilities: Readonly<Record<DesktopCapability, boolean>>
}
