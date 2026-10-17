import { join } from 'node:path'
import { app, BrowserWindow, globalShortcut, ipcMain, shell } from 'electron'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'

import {
  bindOverlayShortcuts,
  closeOverlay,
  registerOverlay,
  type OverlayShortcuts
} from './overlay'
import { cancelPendingCapture, registerCapture } from './capture'
import { startLogging } from './log'
import { registerProcessAudio, stopProcessAudio } from './process-audio'
import { registerUpdaterIpc, startUpdater, stopUpdater } from './updater'

/**
 * Mirante — main process.
 *
 * Deliberately small. It owns the window, the capture picker bridge, and the
 * global hotkeys that a browser tab can never have — which is the entire
 * reason this is a desktop app and not a web page.
 */

// The source picker is 936px wide; the window must never open smaller than
// it plus the scrim padding, or the sheet opens clipped.
const MIN_WIDTH = 1024
const MIN_HEIGHT = 700

let mainWindow: BrowserWindow | null = null

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    autoHideMenuBar: true,
    icon: join(__dirname, '../../build/icon.png'),
    // Frameless: the title bar is part of the design, not OS chrome.
    frame: false,
    // Matches --surface-base so there is no white flash before first paint.
    backgroundColor: '#0a0810',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  window.on('ready-to-show', () => window.show())

  window.on('closed', () => {
    cancelPendingCapture()
    stopProcessAudio()
    mainWindow = null
  })

  // Window state -> renderer, so the custom title bar can swap its maximise icon.
  const emitState = (): void =>
    window.webContents.send('window:state', {
      maximized: window.isMaximized(),
      fullscreen: window.isFullScreen()
    })
  window.on('maximize', emitState)
  window.on('unmaximize', emitState)
  window.on('enter-full-screen', emitState)
  window.on('leave-full-screen', emitState)

  // External links open in the real browser, never inside the app shell.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

function registerWindowControls(): void {
  ipcMain.on('window:minimize', () => mainWindow?.minimize())
  ipcMain.on('window:toggle-maximize', () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on('window:close', () => mainWindow?.close())
  ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized() ?? false)
}

/**
 * Global hotkeys. These keep working while a game has focus, which is the
 * whole point — you should never have to alt-tab out of a match to mute.
 */
function registerHotkeys(): void {
  const bind = (accelerator: string, channel: string): void => {
    const ok = globalShortcut.register(accelerator, () => {
      mainWindow?.webContents.send(channel)
    })
    if (!ok) console.warn(`[hotkey] could not register ${accelerator} (taken by another app)`)
  }

  bind('CommandOrControl+Shift+M', 'hotkey:toggle-mic')
  bind('CommandOrControl+Shift+S', 'hotkey:toggle-screen')
  bind('CommandOrControl+Shift+C', 'hotkey:toggle-camera')
}

void app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.tvmirante.app')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  mainWindow = createWindow()
  startLogging(mainWindow)
  registerWindowControls()
  registerCapture()
  registerProcessAudio(mainWindow)
  registerHotkeys()
  registerOverlay(mainWindow)
  ipcMain.handle('overlay:bind-shortcuts', (event, shortcuts: OverlayShortcuts) =>
    bindOverlayShortcuts(event.sender, shortcuts)
  )
  // The IPC surface always exists, so the renderer can ask about updates in
  // any build. Only a packaged build actually drives the updater — there is
  // no release feed to read from a dev tree.
  registerUpdaterIpc()
  if (app.isPackaged) startUpdater(mainWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
})

app.on('will-quit', () => {
  closeOverlay()
  globalShortcut.unregisterAll()
  stopUpdater()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
