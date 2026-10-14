import { existsSync } from 'node:fs'

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
/**
 * Guards against overlapping checks.
 *
 * `checkForUpdates()` with autoDownload starts a download, and two of them
 * race on the same temp file: one renames it into place, the other dies with
 * ENOENT. That is exactly what happened when the startup check overlapped
 * with someone pressing the button — the UI had already been told the update
 * was ready, so it offered to install a file that no longer existed.
 */
let inFlight: Promise<void> | null = null
/** Where the finished installer actually landed, so we can verify it exists. */
let downloadedPath: string | null = null

/**
 * Register the IPC surface, unconditionally and before anything that can fail.
 *
 * These used to live inside `registerUpdater`, which only runs for packaged
 * builds and does a pile of setup first. Anything throwing in that setup — or
 * simply running unpackaged — left the renderer calling a channel nobody was
 * listening on, and Electron answers that with
 *
 *     Error: No handler registered for 'update:check'
 *
 * An updater that cannot start should report "no updates", not blow up in the
 * user's face. Separating registration from startup makes that structural.
 */
export function registerUpdaterIpc(): void {
  ipcMain.handle('update:state', () => state)

  ipcMain.handle('update:check', async () => {
    if (!started) return state
    await check()
    return state
  })

  ipcMain.on('update:install', () => {
    if (!started) return

    // Antivirus quarantine and failed renames both end here: the event said
    // ready, the file is gone. Checking first turns a Windows "cannot find
    // the file" dialog into a retry.
    if (downloadedPath && !existsSync(downloadedPath)) {
      log('update', 'installer vanished before install:', downloadedPath)
      downloadedPath = null
      setState({
        status: 'error',
        percent: 0,
        message: 'O instalador sumiu do disco. Baixando de novo.'
      })
      void check()
      return
    }

    log('update', 'installing and restarting')
    try {
      autoUpdater.quitAndInstall(false, true)
    } catch (error) {
      log('update', 'quitAndInstall threw:', (error as Error).message)
      setState({ status: 'error', percent: 0, message: 'Nao consegui iniciar o instalador.' })
    }
  })
}

/** Set once the updater is actually wired and safe to drive. */
let started = false
let target: BrowserWindow | null = null

function setState(next: Partial<UpdateState>): void {
  state = { ...state, ...next }
  if (target && !target.isDestroyed()) target.webContents.send('update:state', state)
}

export function startUpdater(window: BrowserWindow): void {
  target = window
  try {
    wire()
    started = true
    void check()
    timer = setInterval(() => void check(), CHECK_INTERVAL_MS)
  } catch (error) {
    // No auto-update is a missing convenience. A crash here would cost the
    // whole app, which is a much worse trade.
    log('update', 'could not start:', (error as Error).message)
    setState({ status: 'idle', message: null })
  }
}

function wire(): void {
  autoUpdater.autoDownload = true
  // We ask first; see the module comment.
  autoUpdater.autoInstallOnAppQuit = true
  /**
   * Download the whole installer, not a delta.
   *
   * Differential download patches the previously cached installer and saves
   * most of the 80 MB, which is lovely until the patch-and-rename step fails
   * and leaves a `ready` event pointing at a file that was never written.
   * A slower download that always produces a real file is the better trade
   * for an app people use a few times a week.
   */
  autoUpdater.disableDifferentialDownload = true
  autoUpdater.logger = {
    info: (m: unknown) => log('update', String(m)),
    warn: (m: unknown) => log('update', 'warn:', String(m)),
    error: (m: unknown) => log('update', 'error:', String(m)),
    debug: () => undefined
  }

  const push = setState

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
    // `downloadedFile` is the authoritative path; trust it over guessing.
    downloadedPath = info.downloadedFile ?? null
    const exists = downloadedPath !== null && existsSync(downloadedPath)
    if (!exists) {
      log('update', `downloaded but missing on disk: ${downloadedPath ?? '(no path)'}`)
      push({
        status: 'error',
        version: info.version,
        percent: 0,
        message: 'O download terminou mas o arquivo sumiu. Tente de novo.'
      })
      return
    }
    log('update', `ready: ${info.version} at ${downloadedPath}`)
    push({ status: 'ready', version: info.version, percent: 100 })
  })

  autoUpdater.on('error', (error) => {
    log('update', 'failed:', error.message)
    // A failure while merely looking is routine — offline, no release yet,
    // GitHub rate limiting — and not worth interrupting anyone over. A
    // failure mid-download is different: the person is waiting on it.
    const wasWorking = state.status === 'downloading' || state.status === 'ready'
    downloadedPath = null
    push(
      wasWorking
        ? { status: 'error', percent: 0, message: 'Falha ao baixar a atualizacao.' }
        : { status: 'idle', percent: 0, message: null }
    )
  })

}


/** Serialised: a second caller joins the running check instead of starting one. */
async function check(): Promise<void> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      await autoUpdater.checkForUpdates()
    } catch (error) {
      log('update', 'check threw:', (error as Error).message)
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

export function stopUpdater(): void {
  if (timer) clearInterval(timer)
  timer = null
  started = false
  target = null
}
