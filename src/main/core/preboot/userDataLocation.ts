import fs from 'node:fs'
import path from 'node:path'

import { app } from 'electron'

import { loggerService } from '@logger'
import {
  DEV_PROFILE_ROOT,
  PORTABLE_EXECUTABLE_NAME,
  resolveDevUserDataPath,
  WINDOWS_PORTABLE_ROOT,
  WINDOWS_PORTABLE_USER_DATA
} from '@main/core/paths/constants'
import { isLinux } from '@main/core/platform'
import { bootConfigService } from '@main/data/bootConfig'

const logger = loggerService.withContext('Preboot')

/**
 * "userData" in this module means Electron's complete OS-level userData
 * directory, including user content, Chromium state, and — on Windows and
 * Linux — application logs. macOS normally keeps logs in ~/Library/Logs;
 * dev profile-root mode keeps them under the configured root on every OS.
 */

export function getNormalizedExecutablePath(): string {
  if (isLinux && process.env.APPIMAGE) {
    return path.join(path.dirname(process.env.APPIMAGE), 'cherry-studio.appimage')
  }
  if (WINDOWS_PORTABLE_ROOT) {
    return path.join(WINDOWS_PORTABLE_ROOT, PORTABLE_EXECUTABLE_NAME)
  }
  return app.getPath('exe')
}

export function canonicalizeUserDataPath(userDataPath: string): string {
  if (!path.isAbsolute(userDataPath)) {
    throw new Error(`userData path must be absolute: ${userDataPath}`)
  }
  return path.normalize(userDataPath)
}

/**
 * Resolve Electron's userData directory before the path registry is frozen.
 * Pending relocation is deliberately not executed here: after the source path
 * is resolved and its single-instance lock is acquired, the
 * `services/userDataRelocation` domain owns validation, copy/switch, commit,
 * progress UI, and relaunch (`runUserDataRelocation()` called from main.ts).
 * The `app.user_data_path` mapping read below is written by that domain's
 * commit step.
 *
 * Electron derives sessionData lazily from userData when no explicit
 * sessionData path was set. Keeping this setPath call before app.whenReady()
 * therefore carries Cookies, Local Storage, IndexedDB, and other Chromium
 * storage to the selected directory as well.
 */
export function resolveUserDataLocation(): void {
  if (!app.isPackaged) {
    const devPath = resolveDevUserDataPath()
    if (DEV_PROFILE_ROOT) {
      const tempPath = path.join(DEV_PROFILE_ROOT, 'home', 'temp')
      fs.mkdirSync(devPath, { recursive: true })
      fs.mkdirSync(tempPath, { recursive: true })
      app.setPath('temp', tempPath)
    }
    app.setPath('userData', devPath)
    logger.info(DEV_PROFILE_ROOT ? 'userData set from dev profile root' : 'userData set with dev suffix', { devPath })
    return
  }

  const exe = getNormalizedExecutablePath()
  const resolved = bootConfigService.get('app.user_data_path')?.[exe]
  if (resolved && isUsableDataDir(resolved)) {
    app.setPath('userData', resolved)
    logger.info('userData set from BootConfig', { exe, resolved })
    return
  }

  if (WINDOWS_PORTABLE_USER_DATA) {
    fs.mkdirSync(WINDOWS_PORTABLE_USER_DATA, { recursive: true })
    app.setPath('userData', WINDOWS_PORTABLE_USER_DATA)
    logger.info('userData set for portable build', { portablePath: WINDOWS_PORTABLE_USER_DATA })
  }
}

/**
 * A usable data directory must be readable, writable, and searchable. This is
 * shared with v1-to-v2 migration path selection so both startup paths enforce
 * the same filesystem bar.
 */
export function isUsableDataDir(value: string): boolean {
  try {
    if (!fs.statSync(value).isDirectory()) return false
    fs.accessSync(value, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}
