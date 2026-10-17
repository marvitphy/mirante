import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'

import type { CaptureSource } from '../../main/capture'
import { ControlDock } from './components/control-dock'
import { IconClose } from './components/icons'
import { JoinScreen } from './components/join-screen'
import { MiranteRail } from './components/mirante-rail'
import { CameraPicker } from './components/camera-picker'
import { SettingsModal } from './components/settings-modal'
import { OverlayPortal } from './overlay/overlay-portal'
import { OverlaySheet, tilesFromRoom, type Anchor } from './overlay/overlay-sheet'
import { prettyShortcut } from './components/shortcut-field'
import { StageGrid } from './components/stage-grid'
import { SourcePicker } from './components/source-picker'
import { Stage, type ViewMode } from './components/stage'
import { TitleBar } from './components/title-bar'
import {
  activeBackground,
  getCustomBackground,
  getSettings,
  listDevices,
  useCustomBackground,
  updateSettings,
  useSettings
} from './lib/settings'
import { useAutoHide } from './lib/use-auto-hide'
import { useHotkeys } from './lib/use-hotkeys'
import { CameraFeed, type SelfView } from './rtc/camera-background'
import { createPcmTrack, type PcmTrackHandle } from './rtc/pcm-track'
import { captureConstraints, type ScreenProfileName } from './rtc/sdp'
import { session, useSession } from './rtc/use-session'

/** Replaced at build time from MIRANTE_SIGNAL_URL — see electron.vite.config.ts. */
declare const __SIGNAL_URL__: string

const DEFAULT_SERVER = __SIGNAL_URL__
/** Filled from the updater state, which already carries the installed build. */
let appVersion = '—'
const STORE_KEY = 'tvmirante.join'
const BACKGROUND_FAILED = 'Não consegui aplicar o fundo. A câmera segue sem ele.'

/** One set of camera constraints, so opening and switching never disagree. */
function cameraConstraints(deviceId: string): MediaTrackConstraints {
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30 }
  }
}

interface JoinDetails {
  name: string
  room: string
  server: string
}

/**
 * A saved server that nobody chose on purpose.
 *
 * The join details are persisted whole, server included, and the server box
 * is prefilled with whatever the build's default was at the time. So the day
 * the development default stopped being localhost, every machine that had
 * ever joined in development carried on dialling localhost — stored as a
 * deliberate preference, which it never was. The app just said
 * "Reconectando" at a port with nothing behind it.
 *
 * Anything pointing at this machine is treated as leftover rather than
 * intent: blank it, and the build's default applies. Someone genuinely
 * running a worker locally types it again, once.
 */
function isLeftoverServer(server: string): boolean {
  return /^wss?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(server.trim())
}

function loadDefaults(): JoinDetails {
  const fallback: JoinDetails = { name: '', room: '', server: '' }
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return fallback
    const stored = JSON.parse(raw) as Partial<JoinDetails>
    return {
      name: stored.name ?? fallback.name,
      room: stored.room ?? fallback.room,
      // A previously-saved empty address must never beat the built-in one,
      // and a leftover localhost is not an address anyone chose.
      server: isLeftoverServer(stored.server ?? '') ? '' : (stored.server?.trim() || '')
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
  /** `first`: turning the camera on asked which one. `adjust`: opened from settings. */
  const [cameraPicker, setCameraPicker] = useState<'first' | 'adjust' | null>(null)
  const settings = useSettings()
  const background = activeBackground(settings, useCustomBackground())
  const defaults = useMemo(loadDefaults, [])

  // Player chrome lives here rather than inside Stage, so the people rail
  // fades in lockstep with the stage controls instead of on its own clock.
  const chrome = useAutoHide(2400, true)

  // Per-process audio track, alive only while sharing with app audio.
  const pcmRef = useRef<PcmTrackHandle | null>(null)

  // The open webcam, with or without a background. The session only ever
  // holds the feed's output, never the webcam itself — see camera-background.
  const feedRef = useRef<CameraFeed | null>(null)
  // Bumped whenever the camera is switched off. Opening with a background
  // takes a moment while MediaPipe loads; leaving the room in that moment
  // must not let the camera come on afterwards.
  const cameraEpochRef = useRef(0)
  // Your own tile: with a mirrored background the picture shown to you is not
  // the one being sent, so it is tracked apart from the published stream.
  const [selfView, setSelfView] = useState<SelfView | null>(null)

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
        // Capture at the frame rate the chosen profile promises — asking for
        // 30 while the profile advertises 60 halves a game before encoding.
        video: captureConstraints(getSettings().defaultProfile),
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

  /**
   * Bring a feed's background in line with the settings, and republish if
   * that changed what it sends.
   *
   * Failing to start the background never takes the camera down with it: the
   * feed keeps sending the plain picture, and you are told.
   */
  const applyBackground = useCallback(async (feed: CameraFeed): Promise<void> => {
    try {
      const wanted = activeBackground(getSettings(), getCustomBackground())
      const changed = await feed.setBackground(wanted)
      // The session stops whatever it replaces, so handing it the stream it
      // already holds would switch the camera off. Only swap a real change,
      // and only for the feed that is still the live one.
      if (changed && feedRef.current === feed) {
        if (session.getSnapshot().local.camera !== feed.output) {
          await session.swapDevice('camera', feed.output)
        }
        feed.releaseRetired()
      }
    } catch (error) {
      console.warn('[background] could not apply:', error)
      setShareError(BACKGROUND_FAILED)
    }
    if (feedRef.current === feed) setSelfView(feed.selfView)
  }, [])

  /**
   * Open a webcam, already wearing its background.
   *
   * With a background on, nothing is published until it is ready. Sending the
   * plain picture first and swapping a second later would show everyone the
   * very room the background exists to hide.
   */
  const openFeed = useCallback(async (deviceId: string): Promise<CameraFeed> => {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: cameraConstraints(deviceId)
    })
    const feed = new CameraFeed(stream, getSettings().mirrorSelf)
    try {
      await feed.setBackground(activeBackground(getSettings(), getCustomBackground()))
    } catch (error) {
      console.warn('[background] could not start:', error)
      setShareError(BACKGROUND_FAILED)
    }
    return feed
  }, [])

  /** Open the camera, using `deviceId` or whatever is already configured. */
  const openCamera = useCallback(
    async (deviceId?: string): Promise<void> => {
      const id = deviceId ?? getSettings().cameraId
      const epoch = cameraEpochRef.current
      try {
        const feed = await openFeed(id)
        if (cameraEpochRef.current !== epoch) {
          feed.close()
          return
        }
        const previous = feedRef.current
        feedRef.current = feed
        await session.setCamera(feed.output)
        previous?.close()
        setSelfView(feed.selfView)
        // The background may have been changed while the camera was opening.
        await applyBackground(feed)
      } catch (error) {
        console.warn('[media] camera denied:', error)
        setShareError('Nao consegui abrir a camera.')
      }
    },
    [applyBackground, openFeed]
  )

  const closeCamera = useCallback(async (): Promise<void> => {
    const feed = feedRef.current
    feedRef.current = null
    cameraEpochRef.current++
    setSelfView(null)
    try {
      await session.setCamera(null)
    } finally {
      // The webcam is the feed's, not the session's: without this the camera
      // light would stay on after the camera was switched off.
      feed?.close()
    }
  }, [])

  const toggleCamera = useCallback(async () => {
    if (snapshot.local.camera) {
      await closeCamera()
      return
    }

    // First time with more than one camera: ask, with a live preview. A list
    // of "Câmera 1 / Câmera 2" is a guess otherwise, and guessing wrong means
    // broadcasting the lid camera instead of the one pointed at your face.
    if (!getSettings().cameraId) {
      const { cameras } = await listDevices()
      if (cameras.length > 1) {
        setCameraPicker('first')
        return
      }
    }

    await openCamera()
  }, [closeCamera, openCamera, snapshot.local.camera])

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
    // The published track may be a background canvas, which has no device;
    // the feed knows which camera is really behind it.
    const feed = feedRef.current
    if (!snapshot.local.camera || !feed || feed.deviceId === settings.cameraId) return
    void (async () => {
      try {
        const next = await openFeed(settings.cameraId)
        // Switched off, or switched again, while this one was opening.
        if (feedRef.current !== feed) {
          next.close()
          return
        }
        feedRef.current = next
        await session.swapDevice('camera', next.output)
        feed.close()
        setSelfView(next.selfView)
      } catch (error) {
        console.warn('[settings] could not switch camera:', error)
      }
    })()
    // Only the chosen device should retrigger this, not every snapshot tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.cameraId])

  // Background on, off or changed: applied to the open camera in place. The
  // webcam stays open throughout, so the light never blinks.
  useEffect(() => {
    if (feedRef.current) void applyBackground(feedRef.current)
  }, [applyBackground, background])

  useEffect(() => {
    const feed = feedRef.current
    if (!feed) return
    feed.setMirror(settings.mirrorSelf)
    setSelfView(feed.selfView)
  }, [settings.mirrorSelf])

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

  /**
   * What the stage should show, derived rather than remembered.
   *
   * This used to hang off `focused` alone, and every path that could leave
   * `focused` empty produced the same wrong answer: leaving the only live
   * broadcast, or the grid collapsing to one, or an expanded panel ending,
   * all landed on "o mirante está vazio" while somebody was plainly still
   * broadcasting. Three bugs, one cause. Asking what exists instead of
   * trusting a field to have been set removes the whole class.
   */
  /**
   * The overlay: a transparent sheet over whatever is in front.
   *
   * Two independent switches, because they answer different questions.
   * `overlayEnabled` is whether the sheet exists at all, and lives in
   * settings. `overlayLive` is whether it currently takes the mouse, which
   * is a moment-to-moment thing and belongs in memory — a sheet that came
   * back holding the mouse after a restart would be a sheet nobody could
   * click past.
   */
  const [overlayLive, setOverlayLive] = useState(false)
  const [takenShortcuts, setTakenShortcuts] = useState<Array<'toggle' | 'interact'>>([])

  /**
   * The overlay's tiles, rebuilt only when the room's media changes.
   *
   * Built inline at first, which meant a new array on every render — and the
   * snapshot re-renders once a second for telemetry alone. Downstream that
   * looked like the whole sheet being replaced continuously.
   */
  const overlayTiles = useMemo(
    () =>
      tilesFromRoom(
        snapshot.peers,
        snapshot.local.camera ? (selfView?.stream ?? snapshot.local.camera) : null,
        snapshot.local.screen,
        settings.mirrorSelf,
        snapshot.self?.name ?? 'você',
        snapshot.self?.hue ?? 268
      ),
    [
      selfView?.stream,
      settings.mirrorSelf,
      snapshot.local.camera,
      snapshot.local.screen,
      snapshot.peers,
      snapshot.self?.hue,
      snapshot.self?.name
    ]
  )

  useEffect(() => {
    const api = window.mirante.overlay
    if (!api) return
    void api
      .bindShortcuts({
        toggle: settings.overlayToggleKey,
        interact: settings.overlayInteractKey
      })
      .then(setTakenShortcuts)
      .catch(() => setTakenShortcuts([]))
  }, [settings.overlayInteractKey, settings.overlayToggleKey])

  useEffect(() => {
    const api = window.mirante.overlay
    if (!api) return
    api.show(settings.overlayEnabled)
    if (!settings.overlayEnabled) setOverlayLive(false)
  }, [settings.overlayEnabled])

  useEffect(() => {
    const api = window.mirante.overlay
    if (!api) return
    api.setInteractive(overlayLive)
  }, [overlayLive])

  useEffect(() => {
    const api = window.mirante.overlay
    if (!api) return
    const offToggle = api.onToggle(() => {
      updateSettings({ overlayEnabled: !getSettings().overlayEnabled })
    })
    const offInteract = api.onInteract(() => {
      // Nothing to hold the mouse for while the sheet is hidden.
      if (!getSettings().overlayEnabled) return
      setOverlayLive((on) => !on)
    })
    return () => {
      offToggle()
      offInteract()
    }
  }, [])

  const stage = useMemo(() => {
    /**
     * Every broadcast in the room gets a panel, joined or not.
     *
     * The stage used to show only what you had joined, and offer the rest
     * one at a time through a single card. With two friends live and you in
     * neither, that meant one of them was simply absent from the screen —
     * no picture, no mention, nothing to click. The room had two things
     * happening and the app showed one.
     *
     * Showing all of them and marking which you are in is both simpler and
     * truer: the stage becomes a picture of the room rather than a picture
     * of your subscriptions.
     */
    // A broadcast is a SHARED SCREEN. A camera is presence: it belongs in
    // the list of people and on the overlay, never on the stage.
    //
    // Treating the two as one thing meant switching your camera on read as
    // going live — it put your face on everyone's stage, counted as "the
    // room is busy" so the next real broadcast could not take the stage by
    // itself, and announced you as live to people who only saw you appear.
    const live = snapshot.peers.filter((p) => p.state.screen)
    const watched = live.filter((p) => p.watching && p.screen !== null)
    const localStream = snapshot.local.screen
    // Your own preview is a panel like any other: while watching friends you
    // still want to see that what you are sending is what you meant to send.
    const panels = live.length + (localStream ? 1 : 0)

    if (focusedPeer) return { kind: 'solo' as const, peer: focusedPeer, live, watched, localStream }
    if (panels > 1) return { kind: 'grid' as const, peer: null, live, watched, localStream }
    // A single thing happening fills the stage — whether you joined it or
    // not, since the one that is not joined is the invitation.
    return { kind: 'solo' as const, peer: localStream ? null : (live[0] ?? null), live, watched, localStream }
  }, [focusedPeer, snapshot.local.screen, snapshot.peers])

  const watched = stage.watched
  const gridded = stage.kind === 'grid'

  /**
   * Who the stage controls act on.
   *
   * NOT `focused`. The stage shows whatever exists — a single watched
   * broadcast appears without anyone having focused it — but every handler
   * was still reading `focused`, so in exactly that case the picture was
   * right and every control was dead: volume, leave, mute, all no-ops with
   * nothing to say why. Leaving one of two broadcasts landed there every
   * time, and the only way out was to join someone again and have the grid
   * rebuild. One source of truth for both halves fixes the class.
   */
  const onStage = stage.peer

  /**
   * Turn someone up, and start hearing them if you were not.
   *
   * Reaching for the volume of a broadcast whose sound is gated off is an
   * unambiguous statement of intent, and answering it with silence makes
   * the control look broken — which is exactly how it looked.
   */
  const setStageVolume = useCallback(
    (peerId: string, volume: number) => {
      session.setPeerAudio(peerId, { volume, muted: false })
      if (session.getSnapshot().listening !== peerId) session.listenTo(peerId)
    },
    []
  )

  const nudgeVolume = useCallback(
    (delta: number) => {
      if (!onStage) return
      setStageVolume(onStage.info.id, Math.min(2, Math.max(0, onStage.audio.volume + delta)))
    },
    [onStage, setStageVolume]
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
        /**
         * One step back, whatever the last step in was.
         *
         * Fullscreen and theatre both narrow the window; expanding a panel
         * narrows the stage. Escape undoes the innermost one and stops
         * there, so the key means the same thing at every depth instead of
         * dropping you to the outside from wherever you happened to be.
         */
        escape: () => {
          if (mode !== 'normal') {
            setMode('normal')
            return
          }
          if (focusedPeer) session.focus(null)
        },
        m: () => {
          if (onStage) {
            session.setPeerAudio(onStage.info.id, { muted: !onStage.audio.muted })
          }
        },
        arrowup: () => nudgeVolume(0.05),
        arrowdown: () => nudgeVolume(-0.05),
        arrowright: () => cycleFocus(1),
        arrowleft: () => cycleFocus(-1)
      }),
      [cycleFocus, focusedPeer, mode, nudgeVolume, onStage, watched.length]
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
      await closeCamera()
      await session.setMic(null)
    } catch (error) {
      console.warn('[leave] media teardown failed:', error)
    } finally {
      session.disconnect()
      setJoined(null)
      setMode('normal')
    }
  }, [closeCamera, stopScreen])

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
      localCamera={snapshot.local.camera ? (selfView?.stream ?? snapshot.local.camera) : null}
      selfSharing={snapshot.local.screen !== null}
      micOn={snapshot.local.mic !== null}
      focused={snapshot.focused}
      visible={chrome.visible}
      mirrorSelf={selfView?.flip ?? settings.mirrorSelf}
      position={settings.railPosition}
      mixer={session.audioMixer}
      onFocus={(peerId) => {
        // Clicking a broadcast you are not receiving is how you join it.
        // Focusing something you cannot see would just show an empty stage.
        const peer = peerId ? snapshot.peers.find((p) => p.info.id === peerId) : null
        if (peer && !peer.watching && peer.state.screen) {
          session.watch(peer.info.id)
          return
        }
        session.focus(peerId)
      }}
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
      onPickCamera={() => setCameraPicker('adjust')}
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
        {gridded ? (
          <StageGrid
            peers={stage.live}
            localStream={stage.localStream}
            localWatchers={snapshot.local.watchers}
            listening={snapshot.listening}
            onListen={(peerId) => session.listenTo(peerId)}
            onExpand={(peerId) => session.focus(peerId)}
            onVolume={(peerId, volume) => setStageVolume(peerId, volume)}
            onToggleMute={(peerId) => {
              const peer = snapshot.peers.find((p) => p.info.id === peerId)
              if (peer) session.setPeerAudio(peerId, { muted: !peer.audio.muted })
            }}
          />
        ) : (
        <Stage
          peer={stage.peer}
          watchers={snapshot.local.watchers}
          siblings={watched.length}
          onBackToGrid={() => session.focus(null)}
          localScreen={snapshot.local.screen}
          mode={mode}
          chromeVisible={chrome.visible}
          onModeChange={setMode}
          onHold={chrome.hold}
          onLeave={() => {
            if (onStage) session.leaveBroadcast(onStage.info.id)
          }}
          onVolume={(volume) => {
            if (onStage) setStageVolume(onStage.info.id, volume)
          }}
          onToggleMute={() => {
            if (onStage) {
              session.setPeerAudio(onStage.info.id, { muted: !onStage.audio.muted })
            }
          }}
          listening={onStage !== null && snapshot.listening === onStage.info.id}
          onListen={() => {
            if (!onStage) return
            const on = snapshot.listening === onStage.info.id
            session.listenTo(on ? null : onStage.info.id)
          }}
        />
        )}

        {settings.railPosition === 'bottom' && rail}
      </main>

      <OverlayPortal open={settings.overlayEnabled}>
        <OverlaySheet
          tiles={overlayTiles}
          anchors={settings.overlayAnchors as Record<string, Anchor>}
          sizes={settings.overlaySizes}
          order={settings.overlayOrder}
          hidden={settings.overlayHidden}
          round={settings.overlayRoundCameras}
          interactive={overlayLive}
          opacity={settings.overlayOpacity}
          listening={snapshot.listening}
          onAnchor={(tileId, anchor, index) => {
            const current = getSettings()
            const anchors = { ...current.overlayAnchors, [tileId]: anchor }

            // Renumber just the corner that changed. Everyone there, minus
            // the tile being moved, with it put back at the position the
            // drop pointed at — so a camera can sit above a broadcast
            // instead of wherever the room happened to list it.
            const neighbours = overlayTiles
              .filter((t) => t.id !== tileId && anchors[t.id] === anchor)
              .sort(
                (a, b) =>
                  (current.overlayOrder[a.id] ?? Number.MAX_SAFE_INTEGER) -
                  (current.overlayOrder[b.id] ?? Number.MAX_SAFE_INTEGER)
              )
              .map((t) => t.id)

            neighbours.splice(Math.min(index, neighbours.length), 0, tileId)

            const overlayOrder = { ...current.overlayOrder }
            neighbours.forEach((id, position) => {
              overlayOrder[id] = position
            })

            updateSettings({ overlayAnchors: anchors, overlayOrder })
          }}
          onSize={(tileId, width) =>
            updateSettings({
              overlaySizes: { ...getSettings().overlaySizes, [tileId]: width }
            })
          }
          onHide={(tileId) =>
            updateSettings({
              overlayHidden: [...new Set([...getSettings().overlayHidden, tileId])]
            })
          }
          onListen={(peerId) => session.listenTo(peerId)}
          onVolume={(peerId, volume) => session.setPeerAudio(peerId, { volume, muted: false })}
          onOpacity={(overlayOpacity) => updateSettings({ overlayOpacity })}
          onRestore={() => updateSettings({ overlayHidden: [] })}
          exitHint={prettyShortcut(settings.overlayInteractKey)}
        />
      </OverlayPortal>

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
            setCameraPicker(null)
            // Opened from settings it only adjusts: a live camera has already
            // followed the choice through the settings effects above.
            if (cameraPicker === 'first') void openCamera(deviceId)
          }}
          onCancel={() => setCameraPicker(null)}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          takenShortcuts={takenShortcuts}
          version={snapshot.self ? appVersion : appVersion}
          onClose={() => setSettingsOpen(false)}
          onAdjustCamera={() => {
            setSettingsOpen(false)
            setCameraPicker('adjust')
          }}
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
