import {
  desktopCapturer,
  ipcMain,
  session,
  type DesktopCapturerSource
} from 'electron'

import { log } from './log'

/**
 * Screen capture wiring.
 *
 * Electron bundles real Chromium, so `desktopCapturer` gives us the same
 * WGC / DXGI capture backends the TeamSpeak teardown found inside
 * TeamSpeak.dll (WgcCaptureSession, DxgiDesktopFrame, GDI fallback) without a
 * line of native code.
 *
 * ## Ordering, and why it was wrong
 *
 * The obvious design — call `getDisplayMedia()`, then show the picker from
 * inside `setDisplayMediaRequestHandler` and resolve the callback when the
 * user chooses — does not survive contact with Electron. It holds Chromium's
 * request open across the whole interaction, and there is no clean way to
 * decline: `callback({})` throws
 *
 *     TypeError: Video was requested, but no video stream was provided
 *
 * which surfaces in the renderer as a useless `AbortError: Error starting
 * capture`. Cancelling the picker and failing to capture become the same
 * event, and an unhandled rejection is logged every time.
 *
 * So the order is inverted. The renderer opens the picker on its own, using
 * `capture:list-sources`. Once a source is chosen it ARMS that choice and only
 * then calls `getDisplayMedia()`, which the handler satisfies immediately from
 * the armed value. Cancelling never reaches Chromium at all, because the
 * request is never made.
 */

/** A capture source, flattened for IPC (native objects do not cross the bridge). */
export interface CaptureSource {
  id: string
  name: string
  kind: 'screen' | 'window'
  /** PNG data URL. */
  thumbnail: string
  /** PNG data URL of the owning app's icon, when the OS provides one. */
  appIcon: string | null
}

/**
 * How the share's audio is sourced.
 *
 * `process` is the default whenever the native addon is available, because it
 * is the only option where your friends' voices cannot physically end up in
 * the broadcast. `system` is opt-in and the UI must warn about echo. See
 * src/main/process-audio.ts.
 */
export type CaptureAudio =
  | { kind: 'none' }
  /** Every app that is playing, minus the ones carrying voices. The default. */
  | { kind: 'everything' }
  | { kind: 'process'; pid: number; label: string }
  /** Whole-endpoint loopback, voices included. Only when the addon is absent. */
  | { kind: 'system' }

export interface CaptureChoice {
  sourceId: string
  audio: CaptureAudio
}

/** The source the renderer committed to, waiting for its getDisplayMedia call. */
let armed: { choice: CaptureChoice; source: DesktopCapturerSource } | null = null

const THUMBNAIL_SIZE = { width: 480, height: 270 }

function toCaptureSource(source: DesktopCapturerSource): CaptureSource {
  return {
    id: source.id,
    name: source.name,
    kind: source.id.startsWith('screen:') ? 'screen' : 'window',
    thumbnail: source.thumbnail.isEmpty() ? '' : source.thumbnail.toDataURL(),
    appIcon: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : null
  }
}

async function readSources(): Promise<DesktopCapturerSource[]> {
  return desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: THUMBNAIL_SIZE,
    fetchWindowIcons: true
  })
}

export function registerCapture(): void {
  ipcMain.handle('capture:list-sources', async (): Promise<CaptureSource[]> => {
    try {
      const sources = await readSources()
      log('capture', `listed ${sources.length} sources`)
      return sources.map(toCaptureSource)
    } catch (error) {
      log('capture', 'getSources failed:', String(error))
      return []
    }
  })

  /**
   * Commit to a source. Re-reads the source list so we hand Chromium a live
   * handle rather than one captured when the picker opened — a window can be
   * closed while someone is deciding.
   */
  ipcMain.handle('capture:arm', async (_event, choice: CaptureChoice): Promise<boolean> => {
    const sources = await readSources()
    const source = sources.find((s) => s.id === choice.sourceId)
    if (!source) {
      log('capture', 'arm failed, source is gone:', choice.sourceId)
      armed = null
      return false
    }
    armed = { choice, source }
    log('capture', `armed "${source.name}" audio=${choice.audio.kind}`)
    return true
  })

  ipcMain.on('capture:disarm', () => {
    if (armed) log('capture', 'disarmed')
    armed = null
  })

  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      if (!armed) {
        // Nothing committed: a stray request, or one we already served. There
        // is no clean decline, so hand back an empty result and swallow the
        // TypeError Electron raises for it.
        log('capture', 'getDisplayMedia with nothing armed — declining')
        try {
          callback({})
        } catch {
          // Expected; see the module comment.
        }
        return
      }

      const { choice, source } = armed
      // One-shot: the next request must arm again.
      armed = null
      log('capture', `granting "${source.name}"`)

      // Only whole-endpoint loopback can ride inside the display-media stream.
      // Per-process audio arrives separately as PCM over IPC and is rebuilt
      // into a track in the renderer — see process-audio.ts.
      callback({
        video: source,
        audio:
          choice.audio.kind === 'system' && process.platform === 'win32'
            ? 'loopback'
            : undefined
      })
    },
    { useSystemPicker: false }
  )
}

/** Drop any armed choice, e.g. when the window closes. */
export function cancelPendingCapture(): void {
  armed = null
}
