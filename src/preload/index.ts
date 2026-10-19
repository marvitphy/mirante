import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

import type { CaptureChoice, CaptureSource } from '../main/capture'
import type { AudioApp, AudioCapability , MixerChannel } from '../main/process-audio'
import type {
  TransferCloseResult,
  TransferFileRef,
  TransferOpenResult,
  TransferWriteResult
} from '../shared/transfer'
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
     * The pictures, fetched separately because they are the expensive part.
     *
     * Measured with eight sources: about 500 ms with thumbnails, about 40 ms
     * without — Chromium grabs a frame of every window to build them, in the
     * main process, where it stalls the whole app. Asking for them after the
     * grid is already drawn keeps the stall off the click.
     */
    thumbnails: () => Promise<Record<string, string>>
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
  /**
   * The live mix of your broadcast, one fader per application.
   *
   * Only meaningful while sharing with sound. The set of applications moves
   * on its own as things start and stop making noise, which is why there is
   * a subscription and not just a getter.
   */
  mixer: {
    channels: () => Promise<MixerChannel[]>
    setGain: (executable: string, gain: number) => Promise<MixerChannel[]>
    onChannels: (handler: (channels: MixerChannel[]) => void) => () => void
  }

  /**
   * The overlay sheet: a transparent, always-on-top window over the game.
   *
   * The window itself is opened by the renderer with `window.open`, because
   * that keeps it in the same process as the live MediaStreams. Everything
   * here is about what KIND of window it is, which only the main process can
   * decide.
   */
  overlay: {
    /** Show or hide the sheet. */
    show: (show: boolean) => void
    /** Take the mouse, or hand it back to whatever is underneath. */
    setInteractive: (on: boolean) => void
    state: () => Promise<{ open: boolean; interactive: boolean }>
    /** Claim the global shortcuts. Resolves with the ones already taken. */
    bindShortcuts: (shortcuts: {
      toggle: string
      interact: string
    }) => Promise<Array<'toggle' | 'interact'>>
    onInteractive: (handler: (on: boolean) => void) => () => void
    onToggle: (handler: () => void) => () => void
    onInteract: (handler: () => void) => () => void
  }

  transfer: {
    open: (files: TransferFileRef[]) => Promise<TransferOpenResult>
    write: (token: string, fileId: string, chunk: ArrayBuffer) => Promise<TransferWriteResult>
    close: (token: string) => Promise<TransferCloseResult>
    cancel: (token: string) => Promise<void>
    reveal: (path: string) => void
  }

  /** Auto-update from GitHub Releases. Packaged builds only. */
  update: {
    state: () => Promise<UpdateState>
    check: () => Promise<UpdateState>
    /** Open the releases page, for when the automatic path cannot work. */
    openReleases: () => void
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
    thumbnails: () =>
      ipcRenderer.invoke('capture:thumbnails') as Promise<Record<string, string>>,
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
  mixer: {
    channels: () => ipcRenderer.invoke('audio:mixer') as Promise<MixerChannel[]>,
    setGain: (executable, gain) =>
      ipcRenderer.invoke('audio:set-gain', executable, gain) as Promise<MixerChannel[]>,
    onChannels: (handler) =>
      subscribe('audio:mixer', (channels) => handler(channels as MixerChannel[]))
  },

  overlay: {
    show: (show: boolean) => ipcRenderer.send('overlay:show', show),
    setInteractive: (on: boolean) => ipcRenderer.send('overlay:interactive', on),
    state: () =>
      ipcRenderer.invoke('overlay:state') as Promise<{ open: boolean; interactive: boolean }>,
    bindShortcuts: (shortcuts) =>
      ipcRenderer.invoke('overlay:bind-shortcuts', shortcuts) as Promise<
        Array<'toggle' | 'interact'>
      >,
    onInteractive: (handler) =>
      subscribe('overlay:interactive', (on) => handler(on as boolean)),
    onToggle: (handler) => subscribe('overlay:hotkey:toggle', () => handler()),
    onInteract: (handler) => subscribe('overlay:hotkey:interact', () => handler())
  },

  transfer: {
    open: (files) => ipcRenderer.invoke('transfer:open', files) as Promise<TransferOpenResult>,
    write: (token, fileId, chunk) =>
      ipcRenderer.invoke('transfer:write', token, fileId, chunk) as Promise<TransferWriteResult>,
    close: (token) => ipcRenderer.invoke('transfer:close', token) as Promise<TransferCloseResult>,
    cancel: (token) => ipcRenderer.invoke('transfer:cancel', token) as Promise<void>,
    reveal: (path) => ipcRenderer.send('transfer:reveal', path)
  },
  update: {
    state: () => ipcRenderer.invoke('update:state') as Promise<UpdateState>,
    check: () => ipcRenderer.invoke('update:check') as Promise<UpdateState>,
    openReleases: () => ipcRenderer.send('update:open-releases'),
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
