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
  parentPid: (pid: number) => number | null
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

/** Level above which the mix is compressed rather than clamped. */
const LIMIT_KNEE = 0.85

interface Source {
  capture: Capture
  /** Samples decoded but not yet mixed. */
  queue: Float32Array[]
  offset: number
  /** Which application this is, so a fader can find it again. */
  executable: string
  /** What Windows calls it, which is what a person recognises. */
  displayName: string
}

/**
 * How loud each application is inside the broadcast.
 *
 * Keyed by executable, never by pid. A pid is not a thing anyone recognises
 * and it does not survive the application itself: Chrome moves its audio
 * between processes as tabs come and go, and a fader tied to a number would
 * reset itself for no visible reason. "Spotify" is what somebody turns down.
 *
 * Outlives the captures on purpose — turn an app down, close it, open it
 * again, and it comes back where you left it.
 */
const appGains = new Map<string, number>()

function gainFor(executable: string): number {
  return appGains.get(executable.toLowerCase()) ?? 1
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
  /**
   * What the person picked, in their words.
   *
   * The window title from the source picker — "Cyberpunk 2077", "YouTube —
   * Chrome". Kept because the fallbacks below it are worse at naming things
   * than the thing the user literally clicked on: resolving an executable
   * can fail outright for an elevated process, and what reached the mixer
   * then was "pid 15064".
   */
  label: string
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
  const gain = gainFor(source.executable)
  if (gain === 0) {
    // Silenced, but still consumed: leaving the samples in the queue would
    // let the backlog grow until the safety valve started dropping chunks,
    // and un-muting would then play a second of stale audio.
    let skipped = 0
    while (skipped < count && source.queue.length > 0) {
      const chunk = source.queue[0]
      const take = Math.min(count - skipped, chunk.length - source.offset)
      skipped += take
      source.offset += take
      if (source.offset >= chunk.length) {
        source.queue.shift()
        source.offset = 0
      }
    }
    return
  }

  let written = 0
  while (written < count && source.queue.length > 0) {
    const chunk = source.queue[0]
    const take = Math.min(count - written, chunk.length - source.offset)
    for (let i = 0; i < take; i++) out[written + i] += chunk[source.offset + i] * gain
    written += take
    source.offset += take
    if (source.offset >= chunk.length) {
      source.queue.shift()
      source.offset = 0
    }
  }
}

/**
 * Drop any pid that already has an ancestor in the set.
 *
 * Captures are opened with `IncludeTree` and the mixer SUMS them, so a parent
 * and its child contribute the same audio twice — +6 dB, which clips on
 * anything loud and reads as crackle or distortion rather than as a volume
 * problem. Chrome makes this the normal case: its browser process and its
 * audio service both hold audio sessions, and the first is an ancestor of the
 * second. Capturing both was guaranteed double-counting.
 */
function dropRedundantTrees(pids: number[]): number[] {
  const mod = loadNative()
  if (!mod || pids.length < 2) return pids

  const set = new Set(pids)
  const parentOf = (pid: number): number | null => {
    try {
      return mod.parentPid(pid) ?? null
    } catch {
      return null
    }
  }

  const kept = pids.filter((pid) => {
    // Walk up until we leave the process tree. Bounded, because a cycle in
    // the parent chain would otherwise hang the capture loop.
    let cursor = parentOf(pid)
    for (let hops = 0; cursor !== null && hops < 24; hops++) {
      if (set.has(cursor)) return false
      cursor = parentOf(cursor)
    }
    return true
  })

  const dropped = pids.length - kept.length
  if (dropped > 0) console.log(`[process-audio] ${dropped} pid(s) ja cobertos por um ancestral`)
  return kept
}

/** What the renderer needs to draw a fader per application. */
export interface MixerChannel {
  executable: string
  displayName: string
  /** 0..2. Above 1 is a boost, which quiet games genuinely need. */
  gain: number
}

/** One row per application currently in the broadcast, loudest name first. */
export function mixerChannels(): MixerChannel[] {
  const seen = new Map<string, MixerChannel>()
  for (const source of sources.values()) {
    const key = source.executable.toLowerCase()
    if (seen.has(key)) continue
    // The audio session's own name where Windows gives one — "Spotify",
    // not "msedgewebview2". Falling back to the file name is better than
    // nothing but it is the thing nobody recognises.
    const name = source.displayName.trim()
    const fromFile = source.executable.replace(/\.exe$/i, '')
    seen.set(key, {
      executable: source.executable,
      // Never a bare pid. If every name resolution failed, the file name
      // without its extension still tells somebody more than a number.
      displayName: name && name !== source.executable ? name : fromFile,
      gain: gainFor(source.executable)
    })
  }
  return [...seen.values()].sort((a, b) => a.displayName.localeCompare(b.displayName))
}

export function setAppGain(executable: string, gain: number): void {
  const key = executable.toLowerCase()
  const clamped = Math.min(2, Math.max(0, gain))
  // Exactly 1 is the default; not storing it keeps the map to the things
  // somebody actually changed.
  if (clamped === 1) appGains.delete(key)
  else appGains.set(key, clamped)
}

/** The pids we want captured right now, resolved fresh every time. */
function desiredPids(): number[] {
  if (!target) return []

  const playing = listAudioApps()

  if (target.kind === 'everything') return dropRedundantTrees(playing.map((a) => a.pid))

  if (target.executable) {
    const wanted = target.executable.toLowerCase()
    return dropRedundantTrees(
      playing.filter((a) => a.executable.toLowerCase() === wanted).map((a) => a.pid)
    )
  }

  // The application could not be named, so the window's own process tree is
  // the best guess left. It is also the pre-Chrome behaviour, which is right
  // for every single-process application.
  return target.seedPid === null ? [] : [target.seedPid]
}

function openCapture(
  mod: NativeModule,
  pid: number,
  executable: string,
  displayName: string
): void {
  try {
    const capture = new mod.ProcessAudioCapture(pid, 'IncludeTree')
    const source: Source = { capture, queue: [], offset: 0, executable, displayName }
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
function rescan(window?: BrowserWindow): void {
  const mod = loadNative()
  if (!mod) return

  const playing = listAudioApps()
  const apps = new Map(playing.map((app) => [app.pid, app]))
  const wanted = new Set(desiredPids())
  const before = sources.size

  for (const pid of [...sources.keys()]) {
    if (!wanted.has(pid)) closeCapture(pid)
  }
  for (const pid of wanted) {
    if (!sources.has(pid)) {
      const app = apps.get(pid)
      const executable = app?.executable ?? executableForPid(pid) ?? `pid ${pid}`
      // Best name first: what Windows calls the audio session, then the
      // window the person actually picked, then the file, then the pid —
      // which is a last resort nobody should ever see.
      const name =
        app?.displayName?.trim() ||
        (target?.kind === 'process' ? target.label.trim() : '') ||
        executable
      openCapture(mod, pid, executable, name)
    }
  }

  // The set of applications changes on its own as things start and stop
  // making noise, so the faders cannot be a snapshot taken when the share
  // opened.
  if (window && !window.isDestroyed() && sources.size !== before) {
    window.webContents.send('audio:mixer', mixerChannels())
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
    target = { kind: 'process', executable, seedPid: plan.pid, label: plan.label }
    console.log(`[process-audio] seguindo ${executable ?? 'pid ' + plan.pid}`)
  } else {
    target = { kind: 'everything', executable: null, seedPid: null, label: '' }
  }

  rescan(window)
  rescanTimer = setInterval(() => rescan(window), RESCAN_INTERVAL_MS)

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

    // Take only what EVERY contributing capture already has.
    //
    // This used to take the maximum and let `drain` zero-fill whatever a
    // source was short by — which is the same as splicing silence into that
    // app's audio and then playing its real samples late, over and over.
    // With a single capture the maximum IS its own backlog, so nothing is
    // ever zero-filled and it sounds perfect; with several, every capture
    // that is a few samples behind the fastest one gets shredded. That is
    // exactly the shape of the complaint: a window shares cleanly and the
    // whole screen crackles.
    //
    // Each capture is its own WASAPI client with its own event loop, so they
    // never arrive in lockstep. The pace is set by the slowest one that has
    // something to give.
    const ready: Source[] = []
    let count = Number.MAX_SAFE_INTEGER
    for (const source of sources.values()) {
      const have = available(source)
      // A capture with less than a frame ready is not "behind", it is idle:
      // its app is simply not making noise. Waiting for it would stall
      // everyone else for as long as that app stays quiet.
      if (have < FRAME_10MS) continue
      ready.push(source)
      if (have < count) count = have
    }
    if (ready.length === 0) return

    count = Math.min(count, MAX_BURST)
    count -= count % CHANNELS
    if (count === 0) return

    const mixed = new Float32Array(count)
    for (const source of ready) drain(source, mixed, count)

    // Soften the top instead of shearing it off.
    //
    // Summed sources can exceed unity, and a hard clamp turns every excursion
    // past 1.0 into a flat edge — which is audible as crackle, not loudness.
    // Below the knee nothing is touched at all; above it the curve compresses
    // smoothly and never reaches 1.0, so there is no flat edge to hear.
    for (let i = 0; i < count; i++) {
      const v = mixed[i]
      const a = v < 0 ? -v : v
      if (a <= LIMIT_KNEE) continue
      const over = (a - LIMIT_KNEE) / (1 - LIMIT_KNEE)
      const shaped = LIMIT_KNEE + (1 - LIMIT_KNEE) * (over / (1 + over))
      mixed[i] = v < 0 ? -shaped : shaped
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
  ipcMain.handle('audio:mixer', () => mixerChannels())
  ipcMain.handle('audio:set-gain', (_event, executable: string, gain: number) => {
    setAppGain(executable, gain)
    return mixerChannels()
  })
}
