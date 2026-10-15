import { createRequire } from 'node:module'
import { basename, join } from 'node:path'
import { app, ipcMain, type BrowserWindow } from 'electron'

import { armedAudioPlan, type AudioPlan } from './capture'

/**
 * Per-application audio capture — the anti-echo system.
 *
 * The problem: system-wide loopback (`audio: 'loopback'`) captures everything
 * leaving your speakers, including your friends' voices from the voice call.
 * Viewers then hear themselves back with a delay. That is the echo everyone
 * knows from bad screen shares.
 *
 * The fix, which both teardowns in docs/teamspeak-rtc-teardown.md show shipping
 * (`com::teamspeak::video::ProcessAudioCapturer`, Discord's audio helper
 * process): capture audio from ONE process tree instead of the endpoint. The
 * voice chat is never in the buffer, so there is nothing to filter out.
 *
 * This module is a thin bridge to native/process-audio. When that addon has not
 * been built, every entry point degrades to "unavailable" and the UI offers only
 * silent sharing or explicitly-warned system loopback.
 */

export interface AudioApp {
  pid: number
  executable: string
  displayName: string
  active: boolean
}

interface NativeModule {
  isSupported: () => boolean
  listAudioApps: () => AudioApp[]
  pidForWindow: (hwnd: number) => number | null
  executableForPid: (pid: number) => string | null
  ProcessAudioCapture: new (
    pid: number,
    mode: 'IncludeTree' | 'ExcludeTree'
  ) => {
    readonly format: { sampleRate: number; channels: number; sampleFormat: string }
    start: (onData: (chunk: Buffer) => void) => void
    stop: () => void
  }
}

/**
 * Applications whose audio must never reach a broadcast, because they carry
 * other people's voices.
 *
 * Names are a weak filter and this list proved it: it said `tvmirante.exe`
 * (the package name) while the shipped binary is `Mirante.exe` (the product
 * name), so our OWN output — your friends' voices, played by this very app —
 * was captured and sent straight back to them. The exact echo the whole
 * per-process design exists to prevent, defeated by a filename.
 *
 * Our own process is now excluded by pid, which cannot drift. The list below
 * covers the other apps people use for voice, matched loosely so that
 * Discord's several channels and TeamSpeak's versioned binaries all land.
 */
const VOICE_APP_PATTERNS = [
  /^discord/i,
  /^teamspeak/i,
  /^ts3client/i,
  /^ts5client/i,
  /^mirante/i,
  /teams/i,
  /^slack/i,
  /^zoom/i,
  /^mumble/i,
  /^skype/i,
  /^webex/i,
  /^steamwebhelper$/i
]

function carriesVoices(executable: string): boolean {
  const name = executable.replace(/\.exe$/i, '')
  return VOICE_APP_PATTERNS.some((pattern) => pattern.test(name))
}

/**
 * Our own binary, whatever it is called today.
 *
 * `Mirante.exe` when packaged, `electron.exe` under `npm run dev`. Hardcoding
 * either one leaks in the other, which is exactly what happened: the shipped
 * build blocked `Mirante.exe` while development ran as `electron.exe` and
 * merrily captured its own output — your friends' voices, played by this app,
 * sent straight back to them.
 *
 * Deriving it from `process.execPath` cannot drift, in either direction.
 */
const OWN_EXECUTABLE = basename(process.execPath).toLowerCase()

/**
 * True for any process that is us.
 *
 * Matching on the executable rather than on `process.pid` matters because
 * Electron plays audio from a CHILD process: the main process pid never
 * appears in the audio session list, so excluding only that pid excluded
 * nothing at all.
 */
function isOurs(app: AudioApp): boolean {
  return app.pid === process.pid || app.executable.toLowerCase() === OWN_EXECUTABLE
}

let native: NativeModule | null = null
let loadError: string | null = null

function loadNative(): NativeModule | null {
  if (native || loadError) return native

  if (process.platform !== 'win32') {
    loadError = 'Captura por aplicativo so existe no Windows.'
    return null
  }

  const require = createRequire(import.meta.url)
  const candidates = [
    join(app.getAppPath(), 'native/process-audio/index.js'),
    join(process.resourcesPath, 'native/process-audio/index.js'),
    '@tvmirante/process-audio'
  ]

  for (const path of candidates) {
    try {
      native = require(path) as NativeModule
      return native
    } catch {
      // try the next location
    }
  }

  loadError =
    'Modulo nativo nao compilado. Rode: npm --prefix native/process-audio run build'
  return null
}

export interface AudioCapability {
  supported: boolean
  reason: string | null
}

/** True when per-application capture is usable right now. */
export function audioAddonReady(): boolean {
  return getAudioCapability().supported
}

/**
 * The executable that owns a pid, e.g. `"chrome.exe"`.
 *
 * A window and the sound it makes are frequently different processes. Chrome
 * gives each window a renderer and puts audio in a separate service; they are
 * siblings, so capturing the window's process TREE records silence — which is
 * why sharing a Chrome window came through mute. Steam behaves the same way.
 *
 * The executable is the only thing the two have in common, so it is what we
 * follow.
 */
export function executableForPid(pid: number): string | null {
  const mod = loadNative()
  if (!mod) return null
  try {
    return mod.executableForPid(pid) ?? null
  } catch {
    return null
  }
}

/** The process that owns a window, or null when it cannot be resolved. */
export function pidForWindow(hwnd: number): number | null {
  const mod = loadNative()
  if (!mod) return null
  try {
    return mod.pidForWindow(hwnd) ?? null
  } catch (error) {
    console.warn('[process-audio] pidForWindow failed:', (error as Error).message)
    return null
  }
}

export function getAudioCapability(): AudioCapability {
  const mod = loadNative()
  if (!mod) return { supported: false, reason: loadError }
  try {
    return mod.isSupported()
      ? { supported: true, reason: null }
      : {
          supported: false,
          reason: 'Windows 10 build 20348 ou mais novo e necessario para captura por aplicativo.'
        }
  } catch (error) {
    return { supported: false, reason: (error as Error).message }
  }
}

/**
 * Apps currently producing audio, minus anything that carries voices.
 * `hint` (usually the shared window title) floats the best match to the top.
 */
export function listAudioApps(hint?: string): AudioApp[] {
  const mod = loadNative()
  if (!mod) return []

  let apps: AudioApp[]
  try {
    apps = mod.listAudioApps()
  } catch (error) {
    // "No apps are playing audio" and "enumeration failed" look identical in
    // the UI, so the difference has to reach the log.
    console.error('[process-audio] listAudioApps failed:', error)
    return []
  }
  console.log(`[process-audio] ${apps.length} audio sessions`)

  const safe = apps.filter((a) => !isOurs(a) && !carriesVoices(a.executable))

  const dropped = apps.length - safe.length
  if (dropped > 0) console.log(`[process-audio] excluded ${dropped} voice-carrying app(s)`)
  if (!hint) return safe

  const needle = hint.toLowerCase()
  return safe.sort((a, b) => score(b) - score(a))

  function score(appInfo: AudioApp): number {
    const name = appInfo.displayName.toLowerCase()
    const exe = appInfo.executable.toLowerCase().replace(/\.exe$/, '')
    let value = appInfo.active ? 1 : 0
    if (needle.includes(exe) || name.includes(needle) || needle.includes(name)) value += 10
    return value
  }
}

// ---------------------------------------------------------------------------

type Capture = InstanceType<NativeModule['ProcessAudioCapture']>

const SAMPLE_RATE = 48_000
const CHANNELS = 2
/** f32 stereo samples per 10 ms — the cadence WASAPI delivers at. */
const FRAME_10MS = (SAMPLE_RATE / 100) * CHANNELS

/**
 * How often we try to forward what has accumulated.
 *
 * Note "try": Windows gives Node a timer resolution around 15.6 ms, so this
 * fires roughly every 15 ms no matter what we ask for. That is fine — what
 * matters is that each tick forwards EVERYTHING waiting rather than a fixed
 * slice, which is the bug this constant used to be half of.
 */
const MIX_INTERVAL_MS = 10

/**
 * Ceiling on one forwarded buffer, as a multiple of 10 ms.
 *
 * Only reached after a real stall. It keeps a recovery from arriving as one
 * enormous burst that the playout side would just have to throw away.
 */
const MAX_BURST = FRAME_10MS * 10

/** Roughly a second of backlog per source before the oldest audio is dropped. */
const MAX_QUEUED = FRAME_10MS * 100

interface Source {
  capture: Capture
  /** Samples decoded but not yet mixed. */
  queue: Float32Array[]
  offset: number
}

/**
 * What we are trying to hear, as a rule rather than a list of pids.
 *
 * Pids are the wrong thing to hold on to. `listAudioApps` can only see a
 * process that ALREADY has an audio session open, and applications open and
 * close those constantly — Chrome creates one when a tab starts playing and
 * drops it when the tab goes quiet. Deciding the set once, at the moment
 * someone pressed share, meant that sharing a Chrome window while it happened
 * to be silent captured nothing and stayed that way forever: viewers saw the
 * picture and heard nothing, with no way back short of restarting the share.
 *
 * So we keep the intent and re-resolve it on a timer.
 */
interface AudioTarget {
  kind: 'process' | 'everything'
  /** For `process`: the application to follow, whatever pids it spawns. */
  executable: string | null
  /** For `process`: the window's own tree, used when the app cannot be named. */
  seedPid: number | null
}

/** How often the set of captured processes is reconciled with reality. */
const RESCAN_INTERVAL_MS = 2_000

const sources = new Map<number, Source>()
let target: AudioTarget | null = null
let mixTimer: NodeJS.Timeout | null = null
let rescanTimer: NodeJS.Timeout | null = null

/** Samples this source has ready. */
function available(source: Source): number {
  let total = -source.offset
  for (const chunk of source.queue) total += chunk.length
  return total
}

/** Pull up to `count` samples from one source, zero-filling what it lacks. */
function drain(source: Source, out: Float32Array, count: number): void {
  let written = 0
  while (written < count && source.queue.length > 0) {
    const chunk = source.queue[0]
    const take = Math.min(count - written, chunk.length - source.offset)
    for (let i = 0; i < take; i++) out[written + i] += chunk[source.offset + i]
    written += take
    source.offset += take
    if (source.offset >= chunk.length) {
      source.queue.shift()
      source.offset = 0
    }
  }
}

/** The pids we want captured right now, resolved fresh every time. */
function desiredPids(): number[] {
  if (!target) return []

  const playing = listAudioApps()

  if (target.kind === 'everything') return playing.map((a) => a.pid)

  if (target.executable) {
    const wanted = target.executable.toLowerCase()
    return playing.filter((a) => a.executable.toLowerCase() === wanted).map((a) => a.pid)
  }

  // The application could not be named, so the window's own process tree is
  // the best guess left. It is also the pre-Chrome behaviour, which is right
  // for every single-process application.
  return target.seedPid === null ? [] : [target.seedPid]
}

function openCapture(mod: NativeModule, pid: number): void {
  try {
    const capture = new mod.ProcessAudioCapture(pid, 'IncludeTree')
    const source: Source = { capture, queue: [], offset: 0 }
    capture.start((chunk) => {
      source.queue.push(
        new Float32Array(
          chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)
        )
      )
      // Safety valve only. Reaching it means the mix loop has stopped running,
      // not that it is merely behind — being behind is now self-correcting.
      while (available(source) > MAX_QUEUED) source.queue.shift()
    })
    sources.set(pid, source)
    console.log(`[process-audio] capturando pid ${pid} (${sources.size} no total)`)
  } catch (error) {
    // One app refusing capture must not sink the rest.
    console.warn(`[process-audio] cannot capture pid ${pid}:`, (error as Error).message)
  }
}

function closeCapture(pid: number): void {
  const source = sources.get(pid)
  if (!source) return
  sources.delete(pid)
  try {
    source.capture.stop()
  } catch (error) {
    console.error('[process-audio] stop failed:', error)
  }
}

/** Bring the open captures in line with what is playing right now. */
function rescan(): void {
  const mod = loadNative()
  if (!mod) return

  const wanted = new Set(desiredPids())

  for (const pid of [...sources.keys()]) {
    if (!wanted.has(pid)) closeCapture(pid)
  }
  for (const pid of wanted) {
    if (!sources.has(pid)) openCapture(mod, pid)
  }
}

/**
 * Start streaming PCM to the renderer, which turns it back into a
 * MediaStreamTrack. Returns the stream format, or null when unavailable.
 *
 * One capture is opened per allowed process and their buffers are summed
 * here. They all read the same render endpoint, so they share its clock and
 * arrive in lockstep — no resampling, no drift correction. A process that
 * falls behind contributes silence for that tick rather than stalling the mix.
 *
 * The format is returned even when nothing is playing yet. The track has to
 * exist from the start of the share: if it only appeared once sound did, the
 * audio would never arrive at all in the ordinary case of opening the video
 * AFTER starting to share.
 */
export function startProcessAudio(
  window: BrowserWindow,
  plan: AudioPlan
): { sampleRate: number; channels: number } | null {
  stopProcessAudio()
  if (plan.kind === 'none' || plan.kind === 'system') return null

  const mod = loadNative()
  if (!mod) return null

  if (plan.kind === 'process') {
    const executable = executableForPid(plan.pid)
    if (executable && carriesVoices(executable)) {
      // Sharing a voice app's own window. Capturing it would broadcast the
      // very voices the per-process design exists to keep out.
      console.log(`[process-audio] ${executable} carrega vozes; sem audio`)
      return null
    }
    target = { kind: 'process', executable, seedPid: plan.pid }
    console.log(`[process-audio] seguindo ${executable ?? 'pid ' + plan.pid}`)
  } else {
    target = { kind: 'everything', executable: null, seedPid: null }
  }

  rescan()
  rescanTimer = setInterval(rescan, RESCAN_INTERVAL_MS)

  // Forward everything that has arrived, not a fixed slice.
  //
  // The fixed slice was a permanent, compounding deficit: WASAPI produces 10 ms
  // of audio every 10 ms of real time, while this timer only actually fires
  // about every 15 ms on Windows. Taking exactly 10 ms per tick consumed at
  // roughly two thirds of the production rate, so the backlog grew without
  // limit until the cap started discarding chunks — a dropout every couple of
  // seconds, forever. Draining what is there instead makes the loop
  // self-correcting: a late tick simply carries more.
  mixTimer = setInterval(() => {
    if (window.isDestroyed()) return

    let count = 0
    for (const source of sources.values()) count = Math.max(count, available(source))
    if (count <= 0) return

    count = Math.min(count, MAX_BURST)
    count -= count % CHANNELS
    if (count === 0) return

    const mixed = new Float32Array(count)
    for (const source of sources.values()) drain(source, mixed, count)
    // Clip rather than wrap: summed streams can exceed unity.
    for (let i = 0; i < count; i++) {
      mixed[i] = mixed[i] > 1 ? 1 : mixed[i] < -1 ? -1 : mixed[i]
    }
    window.webContents.send('audio:pcm', mixed.buffer)
  }, MIX_INTERVAL_MS)

  return { sampleRate: SAMPLE_RATE, channels: CHANNELS }
}

export function stopProcessAudio(): void {
  if (mixTimer) {
    clearInterval(mixTimer)
    mixTimer = null
  }
  if (rescanTimer) {
    clearInterval(rescanTimer)
    rescanTimer = null
  }
  for (const pid of [...sources.keys()]) closeCapture(pid)
  target = null
}

export function registerProcessAudio(window: BrowserWindow): void {
  ipcMain.handle('audio:capability', () => getAudioCapability())
  ipcMain.handle('audio:list-apps', (_event, hint?: string) => listAudioApps(hint))
  // No argument: the plan was already decided when the source was armed.
  ipcMain.handle('audio:start', () => startProcessAudio(window, armedAudioPlan()))
  ipcMain.handle('audio:stop', () => {
    stopProcessAudio()
  })
}
