import { createRequire } from 'node:module'
import { join } from 'node:path'
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
 * Applications whose audio must never reach a broadcast, because they are
 * carrying other people's voices. Pre-filtered out of the picker so you cannot
 * pick the echo by accident.
 */
const VOICE_APPS = new Set([
  'tvmirante.exe',
  'discord.exe',
  'discordptb.exe',
  'discordcanary.exe',
  'teamspeak.exe',
  'ts3client_win64.exe',
  'teams.exe',
  'ms-teams.exe',
  'slack.exe',
  'zoom.exe',
  'mumble.exe',
  'skype.exe'
])

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

  const safe = apps.filter((a) => !VOICE_APPS.has(a.executable.toLowerCase()))
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
/** f32 stereo frames per 10 ms — the cadence WASAPI delivers at. */
const MIX_FRAMES = (SAMPLE_RATE / 100) * CHANNELS

interface Source {
  capture: Capture
  /** Samples decoded but not yet mixed. */
  queue: Float32Array[]
  offset: number
}

let sources: Source[] = []
let mixTimer: NodeJS.Timeout | null = null

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

/**
 * Start streaming PCM for `choice` to the renderer, which turns it back into a
 * MediaStreamTrack. Returns the stream format, or null when unavailable.
 *
 * For `everything`, one capture is opened per allowed process and their
 * buffers are summed here. They all read the same render endpoint, so they
 * share its clock and arrive in lockstep — no resampling, no drift
 * correction. A process that falls behind contributes silence for that tick
 * rather than stalling the mix.
 */
export function startProcessAudio(
  window: BrowserWindow,
  plan: AudioPlan
): { sampleRate: number; channels: number } | null {
  stopProcessAudio()
  if (plan.kind === 'none' || plan.kind === 'system') return null

  const mod = loadNative()
  if (!mod) return null

  const pids = plan.kind === 'process' ? [plan.pid] : listAudioApps().map((a) => a.pid)

  if (pids.length === 0) {
    console.log('[process-audio] nothing playing audio to capture')
    return null
  }

  for (const pid of pids) {
    try {
      const capture = new mod.ProcessAudioCapture(pid, 'IncludeTree')
      const source: Source = { capture, queue: [], offset: 0 }
      capture.start((chunk) => {
        source.queue.push(
          new Float32Array(
            chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)
          )
        )
        // Never let one stalled consumer grow without bound.
        while (source.queue.length > 64) source.queue.shift()
      })
      sources.push(source)
    } catch (error) {
      // One app refusing capture must not sink the rest.
      console.warn(`[process-audio] cannot capture pid ${pid}:`, (error as Error).message)
    }
  }

  if (sources.length === 0) return null
  console.log(`[process-audio] mixing ${sources.length} app(s)`)

  mixTimer = setInterval(() => {
    if (window.isDestroyed()) return
    const mixed = new Float32Array(MIX_FRAMES)
    for (const source of sources) drain(source, mixed, MIX_FRAMES)
    // Clip rather than wrap: summed streams can exceed unity.
    for (let i = 0; i < mixed.length; i++) {
      mixed[i] = mixed[i] > 1 ? 1 : mixed[i] < -1 ? -1 : mixed[i]
    }
    window.webContents.send('audio:pcm', mixed.buffer)
  }, 10)

  return { sampleRate: SAMPLE_RATE, channels: CHANNELS }
}

export function stopProcessAudio(): void {
  if (mixTimer) {
    clearInterval(mixTimer)
    mixTimer = null
  }
  for (const source of sources) {
    try {
      source.capture.stop()
    } catch (error) {
      console.error('[process-audio] stop failed:', error)
    }
  }
  sources = []
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
