import type { CreateDirectoryOptions } from 'webdav'

import type { DataApiDataChangeEffect, DataRequest, DataResponse } from '@shared/data/api/types'
import type { CacheEntry, CacheSyncMessage } from '@shared/data/cache/cacheTypes'
import type {
  UnifiedPreferenceKeyType,
  UnifiedPreferenceMultipleResultType,
  UnifiedPreferenceType
} from '@shared/data/preference/preferenceTypes'
import type { FileEntry } from '@shared/data/types/file'
import type { FileMetadata } from '@shared/data/types/legacyFile'
import type { TraceDataCursor, TraceDataResult } from '@shared/data/types/trace'
import { IpcError } from '@shared/ipc/errors/IpcError'
import { IpcChannel } from '@shared/IpcChannel'
import type { BackupResult, LocalBackupConfig, S3Config, WebDavConfig } from '@shared/types/backup'
import type { MenuAnchor, NativePopupMenuModel, NativePopupMenuResult } from '@shared/types/command'
import type {
  AbsoluteFilePath,
  CreateInternalEntryIpcParams,
  DirectoryEntry,
  DirectoryListOptions,
  EnsureExternalEntryIpcParams,
  GetPhysicalPathIpcParams
} from '@shared/types/file'
import type { ShortcutPreferenceKey } from '@shared/types/shortcut'
import type { CommandId } from '@shared/utils/command'
import { resolveSafeExternalUrl } from '@shared/utils/externalUrlSafety'

import { nativeTransport } from '../gpui/transport'
import type { OpenDialogOptions, OpenExternalOptions, DesktopEvent } from './contracts'
import { ipcApi } from './ipc'

type ShortcutRegistrationConflictPayload = {
  key: ShortcutPreferenceKey
  accelerator?: string
  hasConflict: boolean
}

// Custom APIs for renderer
const api = {
  select: (options: OpenDialogOptions): Promise<string[] | undefined> =>
    nativeTransport.request(IpcChannel.App_Select, options),
  hasWritePermission: (path: string): Promise<boolean> =>
    nativeTransport.request(IpcChannel.App_HasWritePermission, path),
  resolvePath: (path: string): Promise<string> => nativeTransport.request(IpcChannel.App_ResolvePath, path),
  isPathInside: (childPath: string, parentPath: string): Promise<boolean> =>
    nativeTransport.request(IpcChannel.App_IsPathInside, childPath, parentPath),
  system: {
    getHostname: (): Promise<string> => nativeTransport.request(IpcChannel.System_GetHostname)
    // Git Bash is resolved in the main process (settingsBuilder); no renderer API.
  },
  backup: {
    restore: (path: string) => nativeTransport.request(IpcChannel.Backup_Restore, path),
    // Direct backup methods (copy IndexedDB/LocalStorage directories directly)
    backup: (fileName: string, destinationPath: string, skipBackupFile?: boolean) =>
      nativeTransport.request(IpcChannel.Backup_Backup, fileName, destinationPath, skipBackupFile),
    backupToWebdav: (webdavConfig: WebDavConfig): Promise<BackupResult<boolean>> =>
      nativeTransport.request(IpcChannel.Backup_BackupToWebdav, webdavConfig),
    restoreFromWebdav: (webdavConfig: WebDavConfig) =>
      nativeTransport.request(IpcChannel.Backup_RestoreFromWebdav, webdavConfig),
    listWebdavFiles: (webdavConfig: WebDavConfig) =>
      nativeTransport.request(IpcChannel.Backup_ListWebdavFiles, webdavConfig),
    createDirectory: (webdavConfig: WebDavConfig, path: string, options?: CreateDirectoryOptions) =>
      nativeTransport.request(IpcChannel.Backup_CreateDirectory, webdavConfig, path, options),
    deleteWebdavFile: (fileName: string, webdavConfig: WebDavConfig) =>
      nativeTransport.request(IpcChannel.Backup_DeleteWebdavFile, fileName, webdavConfig),
    backupToLocalDir: (fileName: string | undefined, localConfig: LocalBackupConfig): Promise<BackupResult<string>> =>
      nativeTransport.request(IpcChannel.Backup_BackupToLocalDir, fileName, localConfig),
    restoreFromLocalBackup: (fileName: string, localBackupDir?: string) =>
      nativeTransport.request(IpcChannel.Backup_RestoreFromLocalBackup, fileName, localBackupDir),
    listLocalBackupFiles: (localBackupDir?: string) =>
      nativeTransport.request(IpcChannel.Backup_ListLocalBackupFiles, localBackupDir),
    deleteLocalBackupFile: (fileName: string, localBackupDir?: string) =>
      nativeTransport.request(IpcChannel.Backup_DeleteLocalBackupFile, fileName, localBackupDir),
    checkWebdavConnection: (webdavConfig: WebDavConfig) =>
      nativeTransport.request(IpcChannel.Backup_CheckConnection, webdavConfig),
    backupToS3: (s3Config: S3Config): Promise<BackupResult<unknown>> =>
      nativeTransport.request(IpcChannel.Backup_BackupToS3, s3Config),
    restoreFromS3: (s3Config: S3Config) => nativeTransport.request(IpcChannel.Backup_RestoreFromS3, s3Config),
    listS3Files: (s3Config: S3Config) => nativeTransport.request(IpcChannel.Backup_ListS3Files, s3Config),
    deleteS3File: (fileName: string, s3Config: S3Config) =>
      nativeTransport.request(IpcChannel.Backup_DeleteS3File, fileName, s3Config)
  },
  file: {
    select: (options?: OpenDialogOptions): Promise<FileMetadata[] | null> =>
      nativeTransport.request(IpcChannel.File_Select, options),
    createInternalEntry: (params: CreateInternalEntryIpcParams): Promise<FileEntry> =>
      nativeTransport.request(IpcChannel.File_CreateInternalEntry, params),
    ensureExternalEntry: (params: EnsureExternalEntryIpcParams): Promise<FileEntry> =>
      nativeTransport.request(IpcChannel.File_EnsureExternalEntry, params),
    getPhysicalPath: (params: GetPhysicalPathIpcParams): Promise<AbsoluteFilePath> =>
      nativeTransport.request(IpcChannel.File_GetPhysicalPath, params),
    runSweep: () => nativeTransport.request(IpcChannel.File_RunSweep),
    deleteExternalFile: (filePath: string) => nativeTransport.request(IpcChannel.File_DeleteExternalFile, filePath),
    deleteExternalDir: (dirPath: string) => nativeTransport.request(IpcChannel.File_DeleteExternalDir, dirPath),
    move: (path: string, newPath: string) => nativeTransport.request(IpcChannel.File_Move, path, newPath),
    moveDir: (dirPath: string, newDirPath: string) =>
      nativeTransport.request(IpcChannel.File_MoveDir, dirPath, newDirPath),
    rename: (path: string, newName: string) => nativeTransport.request(IpcChannel.File_Rename, path, newName),
    renameDir: (dirPath: string, newName: string) =>
      nativeTransport.request(IpcChannel.File_RenameDir, dirPath, newName),
    readExternal: (filePath: string, detectEncoding?: boolean): Promise<string> =>
      nativeTransport.request(IpcChannel.File_ReadExternal, filePath, detectEncoding),
    get: (filePath: string): Promise<FileMetadata | null> => nativeTransport.request(IpcChannel.File_Get, filePath),
    createTempFile: (fileName: string): Promise<string> =>
      nativeTransport.request(IpcChannel.File_CreateTempFile, fileName),
    mkdir: (dirPath: string) => nativeTransport.request(IpcChannel.File_Mkdir, dirPath),
    write: (filePath: string, data: Uint8Array | string) =>
      nativeTransport.request(IpcChannel.File_Write, filePath, data),
    open: (options?: OpenDialogOptions) => nativeTransport.request(IpcChannel.File_Open, options),
    save: (
      path: string,
      content: string | NodeJS.ArrayBufferView,
      options?: Record<string, unknown>
    ): Promise<string | null> => nativeTransport.request(IpcChannel.File_Save, path, content, options),
    selectFolder: (options?: OpenDialogOptions): Promise<string | null> =>
      nativeTransport.request(IpcChannel.File_SelectFolder, options),
    saveImage: (name: string, data: string): Promise<boolean> =>
      nativeTransport.request(IpcChannel.File_SaveImage, name, data),
    binaryImage: (fileId: string): Promise<string> => nativeTransport.request(IpcChannel.File_BinaryImage, fileId),
    getPathForFile: (file: File) => getPathForFile(file),
    listDirectory: (dirPath: string, options?: DirectoryListOptions) =>
      nativeTransport.request(IpcChannel.File_ListDirectory, dirPath, options),
    listDirectoryEntries: (dirPath: string, options?: DirectoryListOptions): Promise<DirectoryEntry[]> =>
      nativeTransport.request(IpcChannel.File_ListDirectoryEntries, dirPath, options),
    checkFileName: (
      dirPath: string,
      fileName: string,
      isFile: boolean
    ): Promise<{ safeName: string; exists: boolean }> =>
      nativeTransport.request(IpcChannel.File_CheckFileName, dirPath, fileName, isFile),
    validateNotesDirectory: (dirPath: string) =>
      nativeTransport.request(IpcChannel.File_ValidateNotesDirectory, dirPath),
    // Legacy file-watcher bindings (`startFileWatcher` / `stopFileWatcher`
    // / `pauseFileWatcher` / `resumeFileWatcher` / `onFileChange`) and
    // `getDirectoryStructure` were removed alongside the Notes migration
    // to `DirectoryTreeBuilder` (see docs/dev/references/file/directory-tree.md).
    // mutations via `window.api.tree.onMutation` instead.
    batchUploadMarkdown: (
      filePaths: string[],
      targetPath: string
    ): Promise<{ skippedFiles: number; failedFiles: number; fileCount: number; folderCount: number }> =>
      nativeTransport.request(IpcChannel.File_BatchUploadMarkdown, filePaths, targetPath)
  },
  fs: {
    read: (pathOrUrl: string, encoding?: BufferEncoding): Promise<string> =>
      nativeTransport.request(IpcChannel.Fs_Read, pathOrUrl, encoding),
    readText: (pathOrUrl: string): Promise<string> => nativeTransport.request(IpcChannel.Fs_ReadText, pathOrUrl)
  },
  command: {
    showNativePopupMenu: (
      model: NativePopupMenuModel<CommandId>,
      anchor?: MenuAnchor
    ): Promise<NativePopupMenuResult<CommandId> | undefined> =>
      nativeTransport.request(IpcChannel.NativeCommandPopupMenu_Show, model, anchor)
  },
  aes: {
    decrypt: (encryptedData: string, iv: string, secretKey: string) =>
      nativeTransport.request(IpcChannel.Aes_Decrypt, encryptedData, iv, secretKey)
  },
  shell: {
    openExternal: async (url: string, options?: OpenExternalOptions): Promise<void> => {
      if (!resolveSafeExternalUrl(url)) throw new Error('Blocked openExternal for invalid URL')
      const result = await ipcApi.request('system.shell.open_external_website', { url, options })
      if (typeof result !== 'object' || result === null || !('ok' in result)) {
        throw new Error('Invalid IpcApi result')
      }
      if (result.ok === true && 'data' in result && result.data === undefined) return
      if (result.ok === false && 'error' in result) {
        const error = result.error
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          typeof error.code === 'string' &&
          'message' in error &&
          typeof error.message === 'string'
        ) {
          throw IpcError.fromJSON({
            code: error.code,
            message: error.message,
            data: 'data' in error ? error.data : undefined
          })
        }
      }
      throw new Error('Invalid IpcApi result')
    }
  },
  copilot: {
    getAuthMessage: (headers?: Record<string, string>) =>
      nativeTransport.request(IpcChannel.Copilot_GetAuthMessage, headers),
    getCopilotToken: (device_code: string, headers?: Record<string, string>) =>
      nativeTransport.request(IpcChannel.Copilot_GetCopilotToken, device_code, headers),
    saveCopilotToken: (access_token: string) =>
      nativeTransport.request(IpcChannel.Copilot_SaveCopilotToken, access_token),
    getToken: (headers?: Record<string, string>) => nativeTransport.request(IpcChannel.Copilot_GetToken, headers),
    logout: () => nativeTransport.request(IpcChannel.Copilot_Logout),
    getUser: (token: string) => nativeTransport.request(IpcChannel.Copilot_GetUser, token)
  },
  // CherryIN OAuth + Codex / Grok CLI OAuth migrated to IpcApi — see
  // `ipcApi.request('oauth.*' | 'cherryin.*')`.
  // BinaryManager tool manager was migrated to IpcApi — see `window.api.ipcApi` / `ipcApi.request('binary.*')`.
  quoteToMainWindow: (text: string) => nativeTransport.request(IpcChannel.App_QuoteToMain, text),
  // setDisableHardwareAcceleration: (isDisable: boolean) =>
  //   nativeTransport.request(IpcChannel.App_SetDisableHardwareAcceleration, isDisable),
  // setUseSystemTitleBar: (isActive: boolean) => nativeTransport.request(IpcChannel.App_SetUseSystemTitleBar, isActive),
  trace: {
    getData: (topicId: string, traceId: string, cursor?: TraceDataCursor): Promise<TraceDataResult> =>
      nativeTransport.request(IpcChannel.TRACE_GET_DATA, topicId, traceId, cursor)
  },
  shortcut: {
    onRegistrationConflict: (callback: (payload: ShortcutRegistrationConflictPayload) => void): (() => void) => {
      const channel = IpcChannel.Shortcut_RegistrationConflict
      const listener = (_: DesktopEvent, payload: ShortcutRegistrationConflictPayload) => callback(payload)
      return nativeTransport.subscribe(channel, listener)
    }
  },
  // CacheService related APIs
  cache: {
    // Broadcast sync message to other windows
    broadcastSync: (message: CacheSyncMessage): void => nativeTransport.notify(IpcChannel.Cache_Sync, message),

    // Listen for sync messages from other windows
    onSync: (callback: (message: CacheSyncMessage) => void) => {
      const listener = (_: DesktopEvent, message: CacheSyncMessage) => callback(message)
      return nativeTransport.subscribe(IpcChannel.Cache_Sync, listener)
    },

    // Get all shared cache entries from Main for initialization sync
    getAllShared: (): Promise<Record<string, CacheEntry>> => nativeTransport.request(IpcChannel.Cache_GetAllShared)
  },

  // PreferenceService related APIs
  // DO NOT MODIFY THIS SECTION
  preference: {
    get: <K extends UnifiedPreferenceKeyType>(key: K): Promise<UnifiedPreferenceType[K]> =>
      nativeTransport.request(IpcChannel.Preference_Get, key),
    set: <K extends UnifiedPreferenceKeyType>(key: K, value: UnifiedPreferenceType[K]): Promise<void> =>
      nativeTransport.request(IpcChannel.Preference_Set, key, value),
    getMultipleRaw: <K extends UnifiedPreferenceKeyType>(keys: K[]): Promise<UnifiedPreferenceMultipleResultType<K>> =>
      nativeTransport.request(IpcChannel.Preference_GetMultipleRaw, keys),
    setMultiple: (updates: Partial<UnifiedPreferenceType>) =>
      nativeTransport.request(IpcChannel.Preference_SetMultiple, updates),
    getAll: (): Promise<UnifiedPreferenceType> => nativeTransport.request(IpcChannel.Preference_GetAll),
    subscribe: (keys: UnifiedPreferenceKeyType[]) => nativeTransport.request(IpcChannel.Preference_Subscribe, keys),
    onChanged: (
      callback: (key: UnifiedPreferenceKeyType, value: UnifiedPreferenceType[UnifiedPreferenceKeyType]) => void
    ) => {
      const listener = (
        _: DesktopEvent,
        key: UnifiedPreferenceKeyType,
        value: UnifiedPreferenceType[UnifiedPreferenceKeyType]
      ) => callback(key, value)
      return nativeTransport.subscribe(IpcChannel.Preference_Changed, listener)
    }
  },
  // Data API related APIs
  dataApi: {
    request: (req: DataRequest): Promise<DataResponse<unknown>> =>
      nativeTransport.request(IpcChannel.DataApi_Request, req),
    // DataApi data change notifications: single fixed channel, main → all windows.
    onDataChanged: (callback: (effects: DataApiDataChangeEffect[]) => void) => {
      const listener = (_: DesktopEvent, effects: DataApiDataChangeEffect[]) => callback(effects)
      return nativeTransport.subscribe(IpcChannel.DataApi_DataChanged, listener)
    }
  },
  // IpcApi RPC channel — generic forwarder; the typed facade lives in src/renderer/ipc
  ipcApi
}

const getPathForFile: (file: File) => string = () => {
  throw new Error('DESKTOP_UNAVAILABLE: file attachments')
}
export function installBusinessApi(): void {
  window.api = api
}
export type WindowApiType = typeof api
