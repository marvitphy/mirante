import { createRequire } from 'node:module'
import { join } from 'node:path'
import { app, ipcMain, type BrowserWindow } from 'electron'

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

export type AudioSourceChoice =
  | { kind: 'none' }
  /** Capture only this process tree. No echo is structurally possible. */
  | { kind: 'process'; pid: number; label: string }
  /** Whole-endpoint loopback. Echoes if you are in a call. Opt-in only. */
  | { kind: 'system' }

export interface AudioApp {
  pid: number
  executable: string
  displayName: string
  active: boolean
}

interface NativeModule {
  isSupported: () => boolean
  listAudioApps: () => AudioApp[]
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
  } catch {
    return []
  }

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

let activeCapture: Capture | null = null

/**
 * Start streaming PCM for `choice` to the renderer, which turns it back into a
 * MediaStreamTrack. Returns the stream format, or null when unavailable.
 */
export function startProcessAudio(
  window: BrowserWindow,
  choice: AudioSourceChoice
): { sampleRate: number; channels: number } | null {
  stopProcessAudio()
  if (choice.kind !== 'process') return null

  const mod = loadNative()
  if (!mod) return null

  try {
    const capture = new mod.ProcessAudioCapture(choice.pid, 'IncludeTree')
    capture.start((chunk) => {
      if (window.isDestroyed()) return
      // Copy out of the Buffer: the renderer needs an owned ArrayBuffer.
      window.webContents.send(
        'audio:pcm',
        chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)
      )
    })
    activeCapture = capture
    return { sampleRate: capture.format.sampleRate, channels: capture.format.channels }
  } catch (error) {
    console.error('[process-audio] start failed:', error)
    return null
  }
}

export function stopProcessAudio(): void {
  if (!activeCapture) return
  try {
    activeCapture.stop()
  } catch (error) {
    console.error('[process-audio] stop failed:', error)
  }
  activeCapture = null
}

export function registerProcessAudio(window: BrowserWindow): void {
  ipcMain.handle('audio:capability', () => getAudioCapability())
  ipcMain.handle('audio:list-apps', (_event, hint?: string) => listAudioApps(hint))
  ipcMain.handle('audio:start', (_event, choice: AudioSourceChoice) =>
    startProcessAudio(window, choice)
  )
  ipcMain.handle('audio:stop', () => {
    stopProcessAudio()
  })
}
