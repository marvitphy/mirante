import { BrowserWindow, globalShortcut, ipcMain, screen, type WebContents } from 'electron'

import { log } from './log'

/**
 * The overlay window.
 *
 * A transparent, frameless, always-on-top sheet covering the screen, so the
 * cameras and the broadcasts stay visible over a fullscreen game. Two states:
 *
 *   - **passive** (the usual one) — clicks pass straight through to whatever
 *     is underneath. The tiles are visible, slightly faded, and completely
 *     out of the way. You can play through it.
 *   - **interactive** — the sheet takes the mouse so tiles can be dragged and
 *     controls pressed. Entered and left by a shortcut, because while a game
 *     has focus there is no window to click on.
 *
 * ## Why the window is opened by the RENDERER
 *
 * The tiles show live `MediaStream`s that already exist in the main window:
 * cameras and broadcasts that are open and being decoded there. A
 * `MediaStream` cannot cross a process boundary, so a second window created
 * by the main process — a second renderer — could not display them without
 * re-encoding everything a second time.
 *
 * `window.open()` from the renderer keeps the new window in the SAME renderer
 * process, where the streams already live and can simply be assigned to a
 * video element. The main process still gets to decide what kind of window it
 * is, through `setWindowOpenHandler`, which is where transparency, the
 * always-on-top level and the click-through behaviour are set.
 *
 * Verified before building on it: a canvas stream captured in the opener
 * plays in the opened window, same process, no re-encode.
 */

/** Name used by the renderer's `window.open`, and nothing else. */
export const OVERLAY_WINDOW_NAME = 'mirante-overlay'

let overlay: BrowserWindow | null = null
let interactive = false
/** What the renderer last asked for, so a reopened overlay comes back right. */
let shouldShow = false

export interface OverlayShortcuts {
  /** Show or hide the overlay entirely. */
  toggle: string
  /** Take the mouse, or give it back to the game. */
  interact: string
}

export const DEFAULT_OVERLAY_SHORTCUTS: OverlayShortcuts = {
  toggle: 'CommandOrControl+Shift+O',
  interact: 'CommandOrControl+Shift+K'
}

/**
 * Cover the whole work area of the display the main window is on.
 *
 * Work area rather than bounds: the taskbar is not ours to cover, and a
 * transparent window over it swallows clicks people expect to land there.
 */
function fitToScreen(window: BrowserWindow, parent: BrowserWindow | null): void {
  const reference = parent?.getBounds()
  const display = reference
    ? screen.getDisplayMatching(reference)
    : screen.getPrimaryDisplay()
  window.setBounds(display.workArea)
}

/**
 * Passive means invisible to the mouse.
 *
 * `forward: true` keeps move events coming so the renderer can still light
 * up a tile under the cursor, while clicks go to the game underneath.
 */
function applyInteractive(window: BrowserWindow, on: boolean): void {
  window.setIgnoreMouseEvents(!on, { forward: true })
  window.setFocusable(on)
  if (on) window.focus()
  window.webContents.send('overlay:interactive', on)
}

export function registerOverlay(mainWindow: BrowserWindow): void {
  mainWindow.webContents.setWindowOpenHandler(({ frameName }) => {
    if (frameName !== OVERLAY_WINDOW_NAME) return { action: 'deny' }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        transparent: true,
        frame: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        hasShadow: false,
        // Starts out of the way; the renderer turns interaction on by shortcut.
        focusable: false,
        show: false,
        backgroundColor: '#00000000'
      }
    }
  })

  mainWindow.webContents.on('did-create-window', (window, { frameName }) => {
    if (frameName !== OVERLAY_WINDOW_NAME) return

    overlay = window
    fitToScreen(window, mainWindow)

    // Above fullscreen games. 'screen-saver' is the highest level Electron
    // offers and the only one that reliably stays over an exclusive-fullscreen
    // window on Windows.
    window.setAlwaysOnTop(true, 'screen-saver')
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    applyInteractive(window, false)
    interactive = false

    window.on('closed', () => {
      overlay = null
      interactive = false
    })

    // The main window moving to another monitor should take the overlay with
    // it; a sheet pinned to the wrong screen is worse than none.
    const follow = (): void => {
      if (overlay && !overlay.isDestroyed()) fitToScreen(overlay, mainWindow)
    }
    mainWindow.on('move', follow)
    screen.on('display-metrics-changed', follow)

    if (shouldShow) window.showInactive()
    log('overlay', 'window created')
  })

  ipcMain.on('overlay:show', (_event, show: boolean) => {
    shouldShow = show
    if (!overlay || overlay.isDestroyed()) return
    if (show) overlay.showInactive()
    else {
      applyInteractive(overlay, false)
      interactive = false
      overlay.hide()
    }
  })

  ipcMain.on('overlay:interactive', (_event, on: boolean) => {
    if (!overlay || overlay.isDestroyed()) return
    interactive = on
    applyInteractive(overlay, on)
  })

  ipcMain.handle('overlay:state', () => ({ open: overlay !== null, interactive }))
}

/**
 * Bind the overlay's two shortcuts, replacing whatever was bound before.
 *
 * Accelerators come from settings because the defaults collide: on this very
 * machine three of the app's fixed hotkeys were already claimed by other
 * software and silently did nothing. A shortcut you cannot change is a
 * shortcut that belongs to whoever registered it first.
 *
 * Returns the ones that could not be claimed, so the interface can say so
 * instead of leaving someone pressing a dead key.
 */
export function bindOverlayShortcuts(
  sender: WebContents,
  shortcuts: OverlayShortcuts
): Array<keyof OverlayShortcuts> {
  const failed: Array<keyof OverlayShortcuts> = []

  for (const [name, accelerator] of Object.entries(shortcuts) as Array<
    [keyof OverlayShortcuts, string]
  >) {
    globalShortcut.unregister(accelerator)
    if (!accelerator) continue

    const ok = globalShortcut.register(accelerator, () => {
      sender.send(`overlay:hotkey:${name}`)
    })
    if (!ok) {
      failed.push(name)
      log('overlay', `shortcut ${accelerator} refused (taken by another app)`)
    }
  }

  return failed
}

export function closeOverlay(): void {
  if (overlay && !overlay.isDestroyed()) overlay.close()
  overlay = null
}
