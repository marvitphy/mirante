import {
  desktopCapturer,
  ipcMain,
  session,
  type DesktopCapturerSource
} from 'electron'

import { log } from './log'
import { audioAddonReady, pidForWindow } from './process-audio'

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
 * What audio to send with a share.
 *
 * Resolved here, not in the renderer, because it follows mechanically from
 * what the person picked:
 *
 *   a window  -> that window's process, and nothing else
 *   a screen  -> everything playing, minus the apps carrying voices
 *
 * Neither is a question worth asking. The only real choice is sound or no
 * sound, which is why `CaptureChoice` carries a boolean.
 */
export type AudioPlan =
  | { kind: 'none' }
  /** One process tree — the window being shared. */
  | { kind: 'process'; pid: number; label: string }
  /** Every app with audio except the voice blocklist. */
  | { kind: 'everything' }
  /** Whole-endpoint loopback, voices included. Only without the addon. */
  | { kind: 'system' }

export interface CaptureChoice {
  sourceId: string
  /** The only audio decision the person makes. */
  withSound: boolean
}

/** The source the renderer committed to, waiting for its getDisplayMedia call. */
let armed: { plan: AudioPlan; source: DesktopCapturerSource } | null = null

/** Electron names a window source `window:<hwnd>:<n>`. */
function hwndOf(sourceId: string): number | null {
  const match = /^window:(\d+):/.exec(sourceId)
  return match ? Number(match[1]) : null
}

function planAudio(source: DesktopCapturerSource, withSound: boolean): AudioPlan {
  if (!withSound) return { kind: 'none' }
  if (!audioAddonReady()) return { kind: 'system' }

  const hwnd = hwndOf(source.id)
  if (hwnd !== null) {
    const pid = pidForWindow(hwnd)
    // Falling back to 'everything' is right when the window has no resolvable
    // owner: better to send the machine's sound than silence.
    if (pid !== null) return { kind: 'process', pid, label: source.name }
    log('capture', `no pid for window ${source.id}, sending everything instead`)
  }
  return { kind: 'everything' }
}

/** The plan for the armed source, so process-audio can act on it. */
export function armedAudioPlan(): AudioPlan {
  return armed?.plan ?? { kind: 'none' }
}

const THUMBNAIL_SIZE = { width: 480, height: 270 }
/** Asking for no pixels at all. */
const NO_THUMBNAIL = { width: 0, height: 0 }

function toCaptureSource(source: DesktopCapturerSource): CaptureSource {
  return {
    id: source.id,
    name: source.name,
    kind: source.id.startsWith('screen:') ? 'screen' : 'window',
    thumbnail: source.thumbnail.isEmpty() ? '' : source.thumbnail.toDataURL(),
    appIcon: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : null
  }
}

/**
 * List the capturable things.
 *
 * `withPictures` is the whole cost. Measured on a machine with eight
 * sources: around 500 ms with thumbnails and icons, around 40 ms without —
 * Chromium captures a frame of every window to make them, and it does that
 * work in the main process, where it stalls the entire app and is felt as
 * the cursor itself going heavy.
 *
 * So the pictures are now asked for only by the thing that draws pictures.
 */
async function readSources(withPictures: boolean): Promise<DesktopCapturerSource[]> {
  return desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: withPictures ? THUMBNAIL_SIZE : NO_THUMBNAIL,
    fetchWindowIcons: withPictures
  })
}

export function registerCapture(): void {
  // Names and ids, immediately. The picker can draw its whole grid from
  // this and fill the pictures in afterwards, instead of making someone
  // wait half a second staring at the button they just pressed.
  ipcMain.handle('capture:list-sources', async (): Promise<CaptureSource[]> => {
    try {
      const sources = await readSources(false)
      log('capture', `listed ${sources.length} sources`)
      return sources.map(toCaptureSource)
    } catch (error) {
      log('capture', 'getSources failed:', String(error))
      return []
    }
  })

  // The expensive half, requested once the grid is already on screen.
  ipcMain.handle('capture:thumbnails', async (): Promise<Record<string, string>> => {
    try {
      const sources = await readSources(true)
      const out: Record<string, string> = {}
      for (const source of sources) {
        if (!source.thumbnail.isEmpty()) out[source.id] = source.thumbnail.toDataURL()
      }
      return out
    } catch (error) {
      log('capture', 'thumbnails failed:', String(error))
      return {}
    }
  })

  /**
   * Commit to a source. Re-reads the source list so we hand Chromium a live
   * handle rather than one captured when the picker opened — a window can be
   * closed while someone is deciding.
   */
  ipcMain.handle('capture:arm', async (_event, choice: CaptureChoice): Promise<boolean> => {
    // No pictures here: this only needs a live handle, and paying for a
    // frame of every window to get one was half of the stall on sharing.
    const sources = await readSources(false)
    const source = sources.find((s) => s.id === choice.sourceId)
    if (!source) {
      log('capture', 'arm failed, source is gone:', choice.sourceId)
      armed = null
      return false
    }
    const plan = planAudio(source, choice.withSound)
    armed = { plan, source }
    log(
      'capture',
      `armed "${source.name}" audio=${plan.kind}` +
        (plan.kind === 'process' ? ` pid=${plan.pid}` : '')
    )
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

      const { plan, source } = armed
      log('capture', `granting "${source.name}"`)

      // Only whole-endpoint loopback can ride inside the display-media stream.
      // Per-process audio arrives separately as PCM over IPC and is rebuilt
      // into a track in the renderer — see process-audio.ts.
      callback({
        video: source,
        audio: plan.kind === 'system' && process.platform === 'win32' ? 'loopback' : undefined
      })
    },
    { useSystemPicker: false }
  )
}

/** Drop any armed choice, e.g. when the window closes. */
export function cancelPendingCapture(): void {
  armed = null
}
