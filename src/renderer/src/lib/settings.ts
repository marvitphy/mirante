import { useSyncExternalStore } from 'react'

import { setSoundsMuted } from './sounds'
import type { ScreenProfileName } from '../rtc/sdp'

/**
 * Everything the app lets you change, in one place.
 *
 * Kept outside React so that non-component code — the audio mixer, the
 * capture flow, the sound cues — can read the current value without being
 * handed it through props. Persisted to localStorage, because a preference
 * you have to set again every launch is not a preference.
 */

export interface Settings {
  /** Empty means "whatever the system considers default". */
  cameraId: string
  microphoneId: string
  /** Playback device. Applied through setSinkId where the engine allows it. */
  speakerId: string
  /** 0..1, applied to everyone you listen to. */
  masterVolume: number
  /** Join, leave, broadcast start and stop cues. */
  roomSounds: boolean
  /** Quality the next share starts at. */
  defaultProfile: ScreenProfileName
  /** Whether the share picker starts with sound enabled. */
  shareWithSound: boolean
  /** Mirror your own camera preview, as a mirror would. */
  mirrorSelf: boolean
  /**
   * Your own picture behind you on camera. The picture itself is stored
   * apart, under BACKGROUND_KEY; on with no picture saved behaves as off.
   */
  cameraBackground: boolean
  /** Signalling server. Blank falls back to the one baked into the build. */
  server: string
  /**
   * Where the people live.
   *
   * `bottom` floats over the video and fades with the player chrome.
   * `right` takes a column of its own, so nothing is ever drawn on top of
   * what you are watching — which costs width, but on a 16:9 screen showing
   * 16:9 content there is width to spare and height to save.
   */
  railPosition: 'bottom' | 'right'
}

const STORE_KEY = 'mirante.settings'

export const DEFAULT_SETTINGS: Settings = {
  cameraId: '',
  microphoneId: '',
  speakerId: '',
  masterVolume: 1,
  roomSounds: true,
  defaultProfile: 'smooth',
  shareWithSound: true,
  mirrorSelf: true,
  cameraBackground: false,
  server: '',
  railPosition: 'right'
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    // Spread over the defaults so a setting added in a later version does not
    // come back undefined for everyone who already has a stored object.
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

let current = load()
const listeners = new Set<() => void>()

setSoundsMuted(!current.roomSounds)

export function getSettings(): Settings {
  return current
}

export function updateSettings(patch: Partial<Settings>): void {
  current = { ...current, ...patch }
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(current))
  } catch {
    // A full or disabled storage must not stop the setting taking effect now.
  }
  if (patch.roomSounds !== undefined) setSoundsMuted(!patch.roomSounds)
  for (const listener of listeners) listener()
}

/**
 * The background picture, as a JPEG data URL.
 *
 * Kept out of the settings object on purpose. It is a few hundred kilobytes,
 * and every toggle anywhere rewrites the whole settings object — dragging the
 * picture through JSON on each volume nudge is waste, and a picture too big
 * for storage must never be able to stop a volume change from saving.
 */
const BACKGROUND_KEY = 'mirante.customBackground'

function loadBackground(): string | null {
  try {
    return localStorage.getItem(BACKGROUND_KEY)
  } catch {
    return null
  }
}

let customBackground = loadBackground()

export function getCustomBackground(): string | null {
  return customBackground
}

/**
 * Replace the background picture. Returns false when storage refused it —
 * usually a full quota — in which case the previous picture is still there
 * and still in use.
 */
export function setCustomBackground(dataUrl: string): boolean {
  try {
    localStorage.setItem(BACKGROUND_KEY, dataUrl)
  } catch {
    return false
  }
  customBackground = dataUrl
  for (const listener of listeners) listener()
  return true
}

/** The picture to put behind you right now, or null for none. */
export function activeBackground(settings: Settings, picture: string | null): string | null {
  return settings.cameraBackground ? picture : null
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useSettings(): Settings {
  return useSyncExternalStore(subscribe, getSettings, getSettings)
}

export function useCustomBackground(): string | null {
  return useSyncExternalStore(subscribe, getCustomBackground, getCustomBackground)
}

// ---------------------------------------------------------------------------

export interface DeviceList {
  cameras: MediaDeviceInfo[]
  microphones: MediaDeviceInfo[]
  speakers: MediaDeviceInfo[]
}

/**
 * Enumerate devices.
 *
 * Labels are blank until the page has been granted media permission at least
 * once, so a first-run settings screen shows "Câmera 1", "Câmera 2". Asking
 * for permission just to populate a list would turn on someone's camera
 * light for no reason, so we live with the placeholder until they use it.
 */
export async function listDevices(): Promise<DeviceList> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return {
      cameras: devices.filter((d) => d.kind === 'videoinput'),
      microphones: devices.filter((d) => d.kind === 'audioinput'),
      speakers: devices.filter((d) => d.kind === 'audiooutput')
    }
  } catch {
    return { cameras: [], microphones: [], speakers: [] }
  }
}

/** A readable name even before permission has been granted. */
export function deviceLabel(device: MediaDeviceInfo, index: number, kind: string): string {
  if (device.label) return device.label
  return `${kind} ${index + 1}`
}
