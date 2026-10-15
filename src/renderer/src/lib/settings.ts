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
  /** Signalling server. Blank falls back to the one baked into the build. */
  server: string
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
  server: ''
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

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useSettings(): Settings {
  return useSyncExternalStore(subscribe, getSettings, getSettings)
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
