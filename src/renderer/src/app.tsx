import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'

import type { CaptureSource } from '../../main/capture'
import { ControlDock } from './components/control-dock'
import { IconClose } from './components/icons'
import { JoinScreen } from './components/join-screen'
import { MiranteRail } from './components/mirante-rail'
import { CameraPicker } from './components/camera-picker'
import { SettingsModal } from './components/settings-modal'
import { SourcePicker } from './components/source-picker'
import { Stage, type ViewMode } from './components/stage'
import { TitleBar } from './components/title-bar'
import { getSettings, listDevices, useSettings } from './lib/settings'
import { useAutoHide } from './lib/use-auto-hide'
import { useHotkeys } from './lib/use-hotkeys'
import { createPcmTrack, type PcmTrackHandle } from './rtc/pcm-track'
import { CAPTURE_CONSTRAINTS, type ScreenProfileName } from './rtc/sdp'
import { session, useSession } from './rtc/use-session'

/** Replaced at build time from MIRANTE_SIGNAL_URL — see electron.vite.config.ts. */
declare const __SIGNAL_URL__: string

const DEFAULT_SERVER = __SIGNAL_URL__
/** Filled from the updater state, which already carries the installed build. */
let appVersion = '—'
const STORE_KEY = 'tvmirante.join'

interface JoinDetails {
  name: string
  room: string
  server: string
}

function loadDefaults(): JoinDetails {
  const fallback: JoinDetails = { name: '', room: '', server: DEFAULT_SERVER }
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return fallback
    const stored = JSON.parse(raw) as Partial<JoinDetails>
    return {
      name: stored.name ?? fallback.name,
      room: stored.room ?? fallback.room,
      // A previously-saved empty address must never beat the built-in one.
      server: stored.server?.trim() || fallback.server
    }
  } catch {
    // Corrupt or unavailable storage is not worth surfacing.
    return fallback
  }
}

export function App(): JSX.Element {
  const snapshot = useSession()
  const [joined, setJoined] = useState<JoinDetails | null>(null)
  const [pickerSources, setPickerSources] = useState<CaptureSource[] | null>(null)
  const [mode, setMode] = useState<ViewMode>('normal')
  const [shareError, setShareError] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [cameraPicker, setCameraPicker] = useState(false)
  const settings = useSettings()
  const defaults = useMemo(loadDefaults, [])

  // Player chrome lives here rather than inside Stage, so the people rail
  // fades in lockstep with the stage controls instead of on its own clock.
  const chrome = useAutoHide(2400, true)

  // Per-process audio track, alive only while sharing with app audio.
  const pcmRef = useRef<PcmTrackHandle | null>(null)

  // --- capture picker ------------------------------------------------------

  const closePicker = useCallback(() => {
    setPickerSources(null)
    window.mirante.capture.disarm()
  }, [])

  const stopScreen = useCallback(async () => {
    pcmRef.current?.close()
    pcmRef.current = null
    await window.mirante.audio.stop()
    await session.setScreen(null, null)
  }, [])

  /**
   * Open our own picker. Nothing is asked of Chromium yet — `getDisplayMedia`
   * is only called once a source has been committed, in `confirmSource`.
   * Doing it the other way round holds Chromium's request open across the
   * whole interaction and leaves no clean way to cancel; see capture.ts.
   */
  /** Open the picker, whether starting a broadcast or changing its source. */
  const openSourcePicker = useCallback(async () => {
    setShareError(null)
    const sources = await window.mirante.capture.listSources()
    if (sources.length === 0) {
      setShareError('Nenhuma tela ou janela disponível pra capturar.')
      return
    }
    setPickerSources(sources)
  }, [])

  const toggleScreen = useCallback(async () => {
    if (snapshot.local.screen) {
      await stopScreen()
      return
    }
    await openSourcePicker()
  }, [openSourcePicker, snapshot.local.screen, stopScreen])

  const confirmSource = useCallback(async (sourceId: string, withSound: boolean) => {
    setPickerSources(null)

    // Arming resolves what audio to capture from what was picked: a window
    // sends that window's sound, a screen sends everything except voices.
    const armed = await window.mirante.capture.arm({ sourceId, withSound })
    if (!armed) {
      setShareError('Essa janela foi fechada enquanto você escolhia.')
      return
    }

    // Failing to get audio must never cancel the share. Sharing a screen
    // without sound is a degraded session; sharing nothing is a broken app.
    if (withSound) {
      try {
        const format = await window.mirante.audio.start()
        if (format) {
          pcmRef.current?.close()
          pcmRef.current = await createPcmTrack(format.sampleRate, format.channels)
        }
      } catch (error) {
        console.error('[share] audio failed, continuing silent:', error)
        pcmRef.current?.close()
        pcmRef.current = null
        await window.mirante.audio.stop()
        setShareError('Transmitindo sem som: nao consegui capturar o audio.')
      }
    }

    const abandon = async (): Promise<void> => {
      pcmRef.current?.close()
      pcmRef.current = null
      await window.mirante.audio.stop()
      window.mirante.capture.disarm()
    }

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: CAPTURE_CONSTRAINTS,
        // We supply audio ourselves as PCM; asking Chromium for it too and
        // receiving none makes some builds reject the whole request.
        audio: false
      })
    } catch (error) {
      const fault = error as DOMException
      console.error(`[share] getDisplayMedia failed: ${fault.name} — ${fault.message}`)
      await abandon()
      setShareError(`Não consegui abrir a transmissão — ${fault.name}: ${fault.message}`)
      return
    }

    const pcm = pcmRef.current
    if (pcm) stream.addTrack(pcm.track)

    console.log(
      `[share] ok: ${stream.getVideoTracks().length} video, ` +
        `${stream.getAudioTracks().length} audio`
    )
    await session.setScreen(stream, stream.getVideoTracks()[0]?.label ?? null)
  }, [])

  useEffect(() => {
    return window.mirante.audio.onPcm((chunk) => pcmRef.current?.push(chunk))
  }, [])

  useEffect(() => {
    void window.mirante.update
      ?.state()
      .then((s) => {
        appVersion = s.current
      })
      .catch(() => undefined)
  }, [])

  // --- publishing ----------------------------------------------------------

  /** Open the camera, using `deviceId` or whatever is already configured. */
  const openCamera = useCallback(async (deviceId?: string): Promise<void> => {
    const id = deviceId ?? getSettings().cameraId
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          ...(id ? { deviceId: { exact: id } } : {}),
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 }
        }
      })
      await session.setCamera(stream)
    } catch (error) {
      console.warn('[media] camera denied:', error)
      setShareError('Nao consegui abrir a camera.')
    }
  }, [])

  const toggleCamera = useCallback(async () => {
    if (snapshot.local.camera) {
      await session.setCamera(null)
      return
    }

    // First time with more than one camera: ask, with a live preview. A list
    // of "Câmera 1 / Câmera 2" is a guess otherwise, and guessing wrong means
    // broadcasting the lid camera instead of the one pointed at your face.
    if (!getSettings().cameraId) {
      const { cameras } = await listDevices()
      if (cameras.length > 1) {
        setCameraPicker(true)
        return
      }
    }

    await openCamera()
  }, [openCamera, snapshot.local.camera])

  const toggleMic = useCallback(async () => {
    if (snapshot.local.mic) {
      await session.setMic(null)
      return
    }
    try {
      const { microphoneId } = getSettings()
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(microphoneId ? { deviceId: { exact: microphoneId } } : {}),
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1
        }
      })
      await session.setMic(stream)
    } catch (error) {
      console.warn('[media] microphone denied:', error)
    }
  }, [snapshot.local.mic])

  // Global hotkeys keep working while a game has focus — the reason this is a
  // desktop app and not a tab.
  useEffect(() => {
    const offMic = window.mirante.hotkeys.on('toggle-mic', () => void toggleMic())
    const offScreen = window.mirante.hotkeys.on('toggle-screen', () => void toggleScreen())
    const offCamera = window.mirante.hotkeys.on('toggle-camera', () => void toggleCamera())
    return () => {
      offMic()
      offScreen()
      offCamera()
    }
  }, [toggleCamera, toggleMic, toggleScreen])

  // Settings take effect now, not next launch. Volume and output device are
  // instant; camera and microphone are swapped into the live senders with
  // replaceTrack, so viewers never see a reconnect.
  useEffect(() => {
    session.audioMixer.setMasterVolume(settings.masterVolume)
  }, [settings.masterVolume])

  useEffect(() => {
    void session.audioMixer.setOutputDevice(settings.speakerId)
  }, [settings.speakerId])

  useEffect(() => {
    if (!snapshot.local.camera) return
    const active = snapshot.local.camera.getVideoTracks()[0]
    if (!active || active.getSettings().deviceId === settings.cameraId) return
    void (async () => {
      try {
        const next = await navigator.mediaDevices.getUserMedia({
          video: {
            ...(settings.cameraId ? { deviceId: { exact: settings.cameraId } } : {}),
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30 }
          }
        })
        await session.swapDevice('camera', next)
      } catch (error) {
        console.warn('[settings] could not switch camera:', error)
      }
    })()
    // Only the chosen device should retrigger this, not every snapshot tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.cameraId])

  useEffect(() => {
    if (!snapshot.local.mic) return
    const active = snapshot.local.mic.getAudioTracks()[0]
    if (!active || active.getSettings().deviceId === settings.microphoneId) return
    void (async () => {
      try {
        const next = await navigator.mediaDevices.getUserMedia({
          audio: {
            ...(settings.microphoneId ? { deviceId: { exact: settings.microphoneId } } : {}),
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1
          }
        })
        await session.swapDevice('mic', next)
      } catch (error) {
        console.warn('[settings] could not switch microphone:', error)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.microphoneId])

  // --- viewing -------------------------------------------------------------

  const focusedPeer = useMemo(
    () => snapshot.peers.find((p) => p.info.id === snapshot.focused) ?? null,
    [snapshot.focused, snapshot.peers]
  )

  const nudgeVolume = useCallback(
    (delta: number) => {
      if (!focusedPeer) return
      const next = Math.min(2, Math.max(0, focusedPeer.audio.volume + delta))
      session.setPeerAudio(focusedPeer.info.id, { volume: next, muted: false })
    },
    [focusedPeer]
  )

  const cycleFocus = useCallback(
    (direction: 1 | -1) => {
      const ids: Array<string | null> = [null, ...snapshot.peers.map((p) => p.info.id)]
      const current = ids.indexOf(snapshot.focused)
      const next = (current + direction + ids.length) % ids.length
      session.focus(ids[next])
    },
    [snapshot.focused, snapshot.peers]
  )

  useHotkeys(
    useMemo(
      () => ({
        f: () => setMode((m) => (m === 'fullscreen' ? 'normal' : 'fullscreen')),
        t: () => setMode((m) => (m === 'theater' ? 'normal' : 'theater')),
        escape: () => setMode('normal'),
        m: () => {
          if (focusedPeer) {
            session.setPeerAudio(focusedPeer.info.id, { muted: !focusedPeer.audio.muted })
          }
        },
        arrowup: () => nudgeVolume(0.05),
        arrowdown: () => nudgeVolume(-0.05),
        arrowright: () => cycleFocus(1),
        arrowleft: () => cycleFocus(-1)
      }),
      [cycleFocus, focusedPeer, nudgeVolume]
    ),
    joined !== null
  )

  // --- join / leave --------------------------------------------------------

  const join = useCallback((details: JoinDetails) => {
    localStorage.setItem(STORE_KEY, JSON.stringify(details))
    setJoined(details)
    session.connect(details.server || DEFAULT_SERVER, details.room, details.name)
  }, [])

  const leave = useCallback(async () => {
    // Tearing down media must never be able to prevent leaving the room. Any
    // of these can reject, and the caller discards the rejection, so a single
    // failure used to leave the socket open and the server kept you in the
    // room — then the next join added a second copy of you.
    try {
      await stopScreen()
      await session.setCamera(null)
      await session.setMic(null)
    } catch (error) {
      console.warn('[leave] media teardown failed:', error)
    } finally {
      session.disconnect()
      setJoined(null)
      setMode('normal')
    }
  }, [stopScreen])

  if (!joined) {
    return (
      <JoinScreen
        defaultName={defaults.name}
        defaultRoom={defaults.room}
        defaultServer={defaults.server}
        error={snapshot.error}
        connecting={snapshot.status === 'connecting'}
        onJoin={join}
      />
    )
  }

  const rail = (
    <MiranteRail
      peers={snapshot.peers}
      selfName={snapshot.self?.name ?? joined.name}
      selfHue={snapshot.self?.hue ?? 263}
      localCamera={snapshot.local.camera}
      micOn={snapshot.local.mic !== null}
      focused={snapshot.focused}
      visible={chrome.visible}
      mirrorSelf={settings.mirrorSelf}
      position={settings.railPosition}
      mixer={session.audioMixer}
      onFocus={(peerId) => session.focus(peerId)}
      onVolume={(peerId, volume) => session.setPeerAudio(peerId, { volume, muted: false })}
      onToggleMute={(peerId) => {
        const peer = snapshot.peers.find((p) => p.info.id === peerId)
        if (peer) session.setPeerAudio(peerId, { muted: !peer.audio.muted })
      }}
      onToggleMic={() => void toggleMic()}
    />
  )

  const dock = (
    <ControlDock
      sharing={snapshot.local.screen !== null}
      cameraOn={snapshot.local.camera !== null}
      micOn={snapshot.local.mic !== null}
      profile={snapshot.local.profile}
      layout={settings.railPosition === 'right' ? 'column' : 'bar'}
      onToggleScreen={() => void toggleScreen()}
      onChangeSource={() => void openSourcePicker()}
      onToggleCamera={() => void toggleCamera()}
      onToggleMic={() => void toggleMic()}
      onProfile={(profile: ScreenProfileName) => void session.setScreenProfile(profile)}
      onLeave={() => void leave()}
      onSettings={() => setSettingsOpen(true)}
    />
  )

  return (
    <div className={`tm-shell tm-shell--${mode} tm-shell--rail-${settings.railPosition}`}>
      <TitleBar
        room={joined.room}
        status={snapshot.status}
        peerCount={snapshot.peers.length}
        relayed={snapshot.anyRelayed}
      />

      {/* Two layouts, one set of parts.
          `right` gives the video a clean rectangle of its own and parks the
          people and the controls in a fixed column beside it — nothing is
          ever drawn over what you are watching, and nothing fades.
          `bottom` is the player-style arrangement: both float over the video
          and disappear together while you watch. */}
      <main className="tm-main" {...chrome.bind}>
        <Stage
          peer={focusedPeer}
          localScreen={snapshot.local.screen}
          mode={mode}
          chromeVisible={chrome.visible}
          onModeChange={setMode}
          onHold={chrome.hold}
          onVolume={(volume) => {
            if (focusedPeer) {
              session.setPeerAudio(focusedPeer.info.id, { volume, muted: false })
            }
          }}
          onToggleMute={() => {
            if (focusedPeer) {
              session.setPeerAudio(focusedPeer.info.id, { muted: !focusedPeer.audio.muted })
            }
          }}
        />

        {settings.railPosition === 'bottom' && rail}
      </main>

      {settings.railPosition === 'right' ? (
        <aside className="tm-side">
          {rail}
          {dock}
        </aside>
      ) : (
        dock
      )}

      {pickerSources && (
        <SourcePicker
          sources={pickerSources}
          onConfirm={confirmSource}
          onCancel={closePicker}
        />
      )}

      {cameraPicker && (
        <CameraPicker
          onConfirm={(deviceId) => {
            setCameraPicker(false)
            void openCamera(deviceId)
          }}
          onCancel={() => setCameraPicker(false)}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          version={snapshot.self ? appVersion : appVersion}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {shareError && (
        <div className="tm-toast" role="alert">
          <span>{shareError}</span>
          <button type="button" className="tm-iconbtn" onClick={() => setShareError(null)}>
            <IconClose size={14} />
          </button>
        </div>
      )}
    </div>
  )
}
