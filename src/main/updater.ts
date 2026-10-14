import { ipcMain, type BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'

import { log } from './log'

/**
 * Auto-update from GitHub Releases.
 *
 * Friends install the app once and never think about it again: on launch, and
 * every six hours after, it asks the repository's Releases for a newer
 * version, downloads it in the background, and offers to restart.
 *
 * Deliberate choices:
 *
 * - **Never restart on its own.** Quitting mid-stream to install an update is
 *   the rudest thing a live app can do. The renderer gets told, shows a quiet
 *   bar, and the person chooses the moment.
 * - **Download automatically, install manually.** The wait happens before you
 *   are asked, so saying yes is instant.
 * - **Silent when offline.** No network, no release yet, rate-limited GitHub —
 *   all normal, none of them deserve an error in someone's face.
 *
 * Unsigned builds update fine; Windows SmartScreen only complains about the
 * first manual install. See docs in README.
 */

// electron-updater ships CommonJS; this is the documented ESM interop.
const { autoUpdater } = electronUpdater

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'
  version: string | null
  /** 0..100 while downloading. */
  percent: number
  message: string | null
}

let state: UpdateState = { status: 'idle', version: null, percent: 0, message: null }
let timer: NodeJS.Timeout | null = null

export function registerUpdater(window: BrowserWindow): void {
  autoUpdater.autoDownload = true
  // We ask first; see the module comment.
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = {
    info: (m: unknown) => log('update', String(m)),
    warn: (m: unknown) => log('update', 'warn:', String(m)),
    error: (m: unknown) => log('update', 'error:', String(m)),
    debug: () => undefined
  }

  const push = (next: Partial<UpdateState>): void => {
    state = { ...state, ...next }
    if (!window.isDestroyed()) window.webContents.send('update:state', state)
  }

  autoUpdater.on('checking-for-update', () => push({ status: 'checking', message: null }))

  autoUpdater.on('update-available', (info) => {
    log('update', `available: ${info.version}`)
    push({ status: 'downloading', version: info.version, percent: 0 })
  })

  autoUpdater.on('update-not-available', () => push({ status: 'idle', percent: 0 }))

  autoUpdater.on('download-progress', (progress) =>
    push({ status: 'downloading', percent: Math.round(progress.percent) })
  )

  autoUpdater.on('update-downloaded', (info) => {
    log('update', `ready: ${info.version}`)
    push({ status: 'ready', version: info.version, percent: 100 })
  })

  autoUpdater.on('error', (error) => {
    // Offline, no releases published yet, or GitHub rate limiting. None of
    // these are worth interrupting anyone over.
    log('update', 'check failed:', error.message)
    push({ status: 'idle', message: null })
  })

  ipcMain.handle('update:state', () => state)
  ipcMain.handle('update:check', async () => {
    await check()
    return state
  })
  ipcMain.on('update:install', () => {
    log('update', 'installing and restarting')
    autoUpdater.quitAndInstall(false, true)
  })

  void check()
  timer = setInterval(() => void check(), CHECK_INTERVAL_MS)
}

async function check(): Promise<void> {
  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    log('update', 'check threw:', (error as Error).message)
  }
}

export function stopUpdater(): void {
  if (timer) clearInterval(timer)
  timer = null
}
