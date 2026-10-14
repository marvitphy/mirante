import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'

import type { CaptureAudio, CaptureSource } from '../../main/capture'
import { ControlDock } from './components/control-dock'
import { IconClose } from './components/icons'
import { JoinScreen } from './components/join-screen'
import { MiranteRail } from './components/mirante-rail'
import { SourcePicker } from './components/source-picker'
import { Stage, type ViewMode } from './components/stage'
import { TitleBar } from './components/title-bar'
import { useAutoHide } from './lib/use-auto-hide'
import { useHotkeys } from './lib/use-hotkeys'
import { createPcmTrack, type PcmTrackHandle } from './rtc/pcm-track'
import type { ScreenProfileName } from './rtc/sdp'
import { session, useSession } from './rtc/use-session'

/** Replaced at build time from MIRANTE_SIGNAL_URL — see electron.vite.config.ts. */
declare const __SIGNAL_URL__: string

const DEFAULT_SERVER = __SIGNAL_URL__
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
  const toggleScreen = useCallback(async () => {
    if (snapshot.local.screen) {
      await stopScreen()
      return
    }
    setShareError(null)
    const sources = await window.mirante.capture.listSources()
    if (sources.length === 0) {
      setShareError('Nenhuma tela ou janela disponível pra capturar.')
      return
    }
    setPickerSources(sources)
  }, [snapshot.local.screen, stopScreen])

  const confirmSource = useCallback(
    async (sourceId: string, audio: CaptureAudio) => {
      setPickerSources(null)

      const armed = await window.mirante.capture.arm({ sourceId, audio })
      if (!armed) {
        setShareError('Essa janela foi fechada enquanto você escolhia.')
        return
      }

      // Per-process audio is a separate PCM pipe; build its track before the
      // video resolves so both land in the same stream.
      if (audio.kind === 'process') {
        const format = await window.mirante.audio.start(audio)
        if (format) {
          pcmRef.current?.close()
          pcmRef.current = await createPcmTrack(format.sampleRate, format.channels)
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
          video: { frameRate: { ideal: 60, max: 60 } },
          // Only ask Chromium for audio when it is the one supplying it.
          // Requesting audio and receiving none makes some builds reject the
          // whole request.
          audio: audio.kind === 'system'
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
    },
    []
  )

  useEffect(() => {
    return window.mirante.audio.onPcm((chunk) => pcmRef.current?.push(chunk))
  }, [])

  // --- publishing ----------------------------------------------------------

  const toggleCamera = useCallback(async () => {
    if (snapshot.local.camera) {
      await session.setCamera(null)
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
      })
      await session.setCamera(stream)
    } catch (error) {
      console.warn('[media] camera denied:', error)
    }
  }, [snapshot.local.camera])

  const toggleMic = useCallback(async () => {
    if (snapshot.local.mic) {
      await session.setMic(null)
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
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

  return (
    <div className={`tm-shell tm-shell--${mode}`}>
      <TitleBar
        room={joined.room}
        status={snapshot.status}
        peerCount={snapshot.peers.length}
        relayed={snapshot.anyRelayed}
      />

      {/* The stage and the rail share one surface and one chrome timer. The
          rail floats over the stage rather than holding a grid row, so the
          video never loses space it has not earned. */}
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

        <MiranteRail
          peers={snapshot.peers}
          selfName={snapshot.self?.name ?? joined.name}
          selfHue={snapshot.self?.hue ?? 263}
          localCamera={snapshot.local.camera}
          micOn={snapshot.local.mic !== null}
          focused={snapshot.focused}
          visible={chrome.visible}
          mixer={session.audioMixer}
          onFocus={(peerId) => session.focus(peerId)}
          onVolume={(peerId, volume) => session.setPeerAudio(peerId, { volume, muted: false })}
          onToggleMute={(peerId) => {
            const peer = snapshot.peers.find((p) => p.info.id === peerId)
            if (peer) session.setPeerAudio(peerId, { muted: !peer.audio.muted })
          }}
        />
      </main>

      <ControlDock
        sharing={snapshot.local.screen !== null}
        cameraOn={snapshot.local.camera !== null}
        micOn={snapshot.local.mic !== null}
        profile={snapshot.local.profile}
        onToggleScreen={() => void toggleScreen()}
        onToggleCamera={() => void toggleCamera()}
        onToggleMic={() => void toggleMic()}
        onProfile={(profile: ScreenProfileName) => void session.setScreenProfile(profile)}
        onLeave={() => void leave()}
      />

      {pickerSources && (
        <SourcePicker
          sources={pickerSources}
          onConfirm={confirmSource}
          onCancel={closePicker}
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
