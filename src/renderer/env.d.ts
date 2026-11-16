/// <reference types="vite/client" />
import type { AppEdition } from '@shared/types/appEdition'
declare global {
  const __APP_EDITION__: AppEdition
  const __APP_RELEASE_NOTES__: string
  const __APP_RELEASE_VERSION__: string
  const __APP_RELEASE_HISTORY__: ReadonlyArray<{ readonly releaseNotes: string; readonly version: string }>
}
