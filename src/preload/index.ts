import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

import type { CaptureChoice, CaptureSource } from '../main/capture'
import type { AudioApp, AudioCapability } from '../main/process-audio'
import type { UpdateState } from '../main/updater'

export interface WindowState {
  maximized: boolean
  fullscreen: boolean
}

export type HotkeyChannel = 'toggle-mic' | 'toggle-screen' | 'toggle-camera'

/** The complete surface the renderer is allowed to touch. Nothing else crosses. */
export interface MiranteApi {
  window: {
    minimize: () => void
    toggleMaximize: () => void
    close: () => void
    isMaximized: () => Promise<boolean>
    onState: (handler: (state: WindowState) => void) => () => void
  }
  capture: {
    /** Everything shareable right now, with live thumbnails. */
    listSources: () => Promise<CaptureSource[]>
    /**
     * Commit to a source, then call `getDisplayMedia()`. Resolves false when
     * the source disappeared while the picker was open. Arming before asking
     * is what keeps cancellation out of Chromium entirely — see capture.ts.
     */
    arm: (choice: CaptureChoice) => Promise<boolean>
    /** Drop an armed choice without starting a capture. */
    disarm: () => void
  }
  /**
   * Per-application audio. The whole point is that your friends' voices never
   * enter the broadcast — see src/main/process-audio.ts.
   */
  audio: {
    capability: () => Promise<AudioCapability>
    /** `hint` is usually the shared window title, used to rank the list. */
    listApps: (hint?: string) => Promise<AudioApp[]>
    /**
     * Begin capturing audio for the source that was just armed. Takes no
     * argument: what to capture follows from what was picked.
     */
    start: () => Promise<{ sampleRate: number; channels: number } | null>
    stop: () => Promise<void>
    /** Interleaved f32 PCM frames from the captured process. */
    onPcm: (handler: (chunk: ArrayBuffer) => void) => () => void
  }
  hotkeys: {
    on: (key: HotkeyChannel, handler: () => void) => () => void
  }
  /** Auto-update from GitHub Releases. Packaged builds only. */
  update: {
    state: () => Promise<UpdateState>
    check: () => Promise<UpdateState>
    /** Quit and apply the downloaded update. */
    install: () => void
    onState: (handler: (state: UpdateState) => void) => () => void
  }
  platform: NodeJS.Platform
}

function subscribe(channel: string, handler: (...args: unknown[]) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, ...args: unknown[]): void => handler(...args)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: MiranteApi = {
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggle-maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized') as Promise<boolean>,
    onState: (handler) => subscribe('window:state', (state) => handler(state as WindowState))
  },
  capture: {
    listSources: () => ipcRenderer.invoke('capture:list-sources') as Promise<CaptureSource[]>,
    arm: (choice) => ipcRenderer.invoke('capture:arm', choice) as Promise<boolean>,
    disarm: () => ipcRenderer.send('capture:disarm')
  },
  audio: {
    capability: () => ipcRenderer.invoke('audio:capability') as Promise<AudioCapability>,
    listApps: (hint) => ipcRenderer.invoke('audio:list-apps', hint) as Promise<AudioApp[]>,
    start: () =>
      ipcRenderer.invoke('audio:start') as Promise<{
        sampleRate: number
        channels: number
      } | null>,
    stop: () => ipcRenderer.invoke('audio:stop') as Promise<void>,
    onPcm: (handler) => subscribe('audio:pcm', (chunk) => handler(chunk as ArrayBuffer))
  },
  hotkeys: {
    on: (key, handler) => subscribe(`hotkey:${key}`, () => handler())
  },
  update: {
    state: () => ipcRenderer.invoke('update:state') as Promise<UpdateState>,
    check: () => ipcRenderer.invoke('update:check') as Promise<UpdateState>,
    install: () => ipcRenderer.send('update:install'),
    onState: (handler) => subscribe('update:state', (next) => handler(next as UpdateState))
  },
  platform: process.platform
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('electron', electronAPI)
  contextBridge.exposeInMainWorld('mirante', api)
} else {
  // contextIsolation disabled only in unusual dev setups; assigning onto the
  // global is the documented fallback. Written through globalThis because this
  // file is compiled by the Node tsconfig, which has no DOM lib.
  ;(globalThis as unknown as { mirante: MiranteApi }).mirante = api
}
