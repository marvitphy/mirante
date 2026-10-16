import { useCallback, useEffect, useRef, useState, type JSX } from 'react'

import {
  formatBitrate,
  formatElapsed,
  formatLoss,
  formatMs,
  formatResolution
} from '../lib/format'
import type { PeerView } from '../rtc/mesh-session'
import {
  IconCollapse,
  IconExpand,
  IconGrid,
  IconLeave,
  IconSignal,
  IconTheater,
  IconVolume,
  IconVolumeOff
} from './icons'
import { Logo } from './logo'
import { SignalMeter } from './signal-meter'
import { VolumeSlider } from './volume-slider'

/**
 * The stage: the thing you actually came to watch.
 *
 * It fills the whole content area and centres the video with `contain`.
 * Everything else floats on top and fades. The affordances are the ones people
 * already know from video players — double-click fills the screen, Esc comes
 * back, chrome disappears while you watch — because the alternative is making
 * someone learn a new vocabulary to watch their friend play a game.
 *
 * Chrome visibility is owned by App, not here, so the people rail can fade in
 * lockstep with these controls.
 */

export type ViewMode = 'normal' | 'theater' | 'fullscreen'

interface StageProps {
  peer: PeerView | null
  /** Local preview, shown when nobody else is publishing. */
  localScreen: MediaStream | null
  /** How many people have your broadcast open, when the broadcast is yours. */
  watchers: number
  mode: ViewMode
  chromeVisible: boolean
  onModeChange: (mode: ViewMode) => void
  onVolume: (volume: number) => void
  onToggleMute: () => void
  /** Pin the chrome open while a popover is on screen. */
  onHold: (held: boolean) => void
  /** Step out of this broadcast: back to the grid, and silence it. */
  onLeave: () => void
  /** How many broadcasts are joined, so the way back to the grid can appear. */
  siblings: number
  onBackToGrid: () => void
  /** Whether this broadcast's own sound is the one playing. */
  listening: boolean
  onListen: () => void
}

export function Stage({
  peer,
  localScreen,
  watchers,
  mode,
  chromeVisible,
  onModeChange,
  onVolume,
  onToggleMute,
  onHold,
  onLeave,
  siblings,
  onBackToGrid,
  listening,
  onListen
}: StageProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [showStats, setShowStats] = useState(false)
  const [, setClockTick] = useState(0)

  // The focused person's screen, their camera if they have no screen, and
  // your own preview if they have neither.
  //
  // Order matters and so does the fallback. Screen before camera is what
  // stops a camera turning on mid-broadcast from taking the stage. The
  // fallback to local is what stops the stage going blank while you are
  // the one broadcasting: focus lands on a peer the moment they ANNOUNCE a
  // stream, which is before any track of theirs has arrived, and until then
  // `peer.screen` is null. The screen you were sharing simply vanished from
  // your own window while everyone else watched it fine.
  const remote = peer ? (peer.screen ?? peer.camera) : null
  const stream = remote ?? localScreen
  const showingLocal = remote === null && localScreen !== null
  const live = remote !== null ? peer?.link === 'live' : localScreen !== null

  // `srcObject` is not a React prop; it has to be assigned imperatively.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (video.srcObject !== stream) {
      video.srcObject = stream
      if (stream) void video.play().catch(() => undefined)
    }
  }, [stream])

  // Drive the elapsed clock once a second rather than on every stats update.
  useEffect(() => {
    if (!live) return
    const id = window.setInterval(() => setClockTick((n) => n + 1), 1000)
    return () => window.clearInterval(id)
  }, [live])

  const enterFullscreen = useCallback(async () => {
    const node = containerRef.current
    if (!node) return
    try {
      await node.requestFullscreen({ navigationUI: 'hide' })
    } catch {
      onModeChange('theater')
    }
  }, [onModeChange])

  useEffect(() => {
    if (mode === 'fullscreen' && !document.fullscreenElement) void enterFullscreen()
    if (mode !== 'fullscreen' && document.fullscreenElement) void document.exitFullscreen()
  }, [enterFullscreen, mode])

  // The user can leave fullscreen with Esc or F11 behind our back.
  useEffect(() => {
    const onChange = (): void => {
      if (!document.fullscreenElement && mode === 'fullscreen') onModeChange('normal')
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [mode, onModeChange])

  const toggleFullscreen = (): void =>
    onModeChange(mode === 'fullscreen' ? 'normal' : 'fullscreen')
  const toggleTheater = (): void => onModeChange(mode === 'theater' ? 'normal' : 'theater')

  // The last frame of a broadcast you stepped out of, so the stage shows
  // what you would be going back to instead of a black rectangle.
  if (!stream) {
    return (
      <div className="tm-stage tm-stage--empty" ref={containerRef}>
        <div className="tm-stage__placeholder">
          <Logo size={44} dark className="tm-stage__mark" />
          <h2>O mirante está vazio</h2>
          <p>
            Compartilhe sua tela ou espere alguém começar. Quem transmitir primeiro sobe
            pro palco automaticamente.
          </p>
        </div>
      </div>
    )
  }

  const stats = showingLocal ? undefined : peer?.stats
  const title =
    peer && !showingLocal
      ? (peer.state.screenLabel ?? `Tela de ${peer.info.name}`)
      : 'Sua tela · prévia local'

  return (
    <div
      ref={containerRef}
      className={`tm-stage${chromeVisible ? '' : ' is-idle'}`}
      onDoubleClick={toggleFullscreen}
    >
      <video
        ref={videoRef}
        className="tm-stage__video"
        playsInline
        autoPlay
        // Remote audio is routed through the AudioMixer so each person gets
        // their own volume; the element itself must stay silent or we would
        // hear every stream twice.
        muted
      />

      <div className="tm-stage__top" data-visible={chromeVisible}>
        <div className="tm-stage__identity">
          {live && (
            <span className="tm-tally" title="Transmissão ao vivo">
              <span className="tm-tally__lamp" />
              AO VIVO
            </span>
          )}

          {/* Your own broadcast: say whether anyone is actually there.
              Going live stopped meaning being seen the day joining became a
              choice, and an empty room should not look like a full one. */}
          {showingLocal && (
            <span
              className={`tm-audience${watchers === 0 ? ' is-empty' : ''}`}
              title={
                watchers === 0
                  ? 'Ninguém abriu sua transmissão ainda'
                  : `${watchers} ${watchers === 1 ? 'pessoa está vendo' : 'pessoas estão vendo'}`
              }
            >
              {watchers === 0 ? 'ninguém assistindo' : `${watchers} assistindo`}
            </span>
          )}
          <span className="tm-stage__title">{title}</span>
          {peer && (
            <span className="tm-stage__elapsed num">{formatElapsed(peer.info.joinedAt)}</span>
          )}
        </div>

        <div className="tm-stage__tools">
          {peer && (
            <button
              type="button"
              className="tm-stage__leave"
              onClick={onLeave}
              title={`Sair da transmissão de ${peer.info.name} — volta pra grade e silencia`}
            >
              <IconLeave size={14} />
              Sair da live
            </button>
          )}

          {stats && (
            <button
              type="button"
              className={`tm-iconbtn${showStats ? ' is-active' : ''}`}
              onClick={() => setShowStats((v) => !v)}
              title="Telemetria · D"
              aria-pressed={showStats}
            >
              <IconSignal size={16} />
            </button>
          )}
        </div>
      </div>

      {showStats && stats && (
        <aside className="tm-stats" aria-label="Telemetria da transmissão">
          <Row label="latência" value={formatMs(stats.rttMs)} />
          <Row label="taxa" value={formatBitrate(stats.bitrate)} />
          <Row label="quadros" value={stats.framerate > 0 ? `${stats.framerate} fps` : '—'} />
          <Row label="resolução" value={formatResolution(stats.width, stats.height)} />
          <Row label="perda" value={formatLoss(stats.lossRatio)} />
          <Row label="jitter" value={formatMs(stats.jitterMs)} />
          <Row label="codec" value={stats.codec || '—'} />
          <Row
            label="limite"
            value={LIMITATION_LABELS[stats.limitation]}
            warn={stats.limitation === 'cpu'}
          />
          <Row
            label="caminho"
            value={stats.relayed ? 'TURN' : stats.candidateType || 'direto'}
            warn={stats.relayed}
          />
        </aside>
      )}

      <div className="tm-stage__bottom" data-visible={chromeVisible}>
        {peer && !showingLocal && (
          <>
            <SignalMeter stats={peer.stats} live={live} variant="inline" />
            <div
              className="tm-stage__volume"
              onMouseEnter={() => onHold(true)}
              onMouseLeave={() => onHold(false)}
            >
              {/* Named, because the same control also exists on the rail tile
                  and nobody should have to work out which person it affects. */}
              {/* The sound of the broadcast, on or off. Separate from the
                  slider below it, which sets how loud this person is once
                  you are hearing them — and which now turns this on rather
                  than moving a control with no audible effect. */}
              <button
                type="button"
                className={`tm-stage__listen${listening ? ' is-on' : ''}`}
                onClick={onListen}
                aria-pressed={listening}
                title={
                  listening
                    ? `Silenciar a transmissão de ${peer.info.name}`
                    : `Ouvir a transmissão de ${peer.info.name}`
                }
              >
                {listening ? <IconVolume size={14} /> : <IconVolumeOff size={14} />}
              </button>
              <span className="tm-stage__volume-who label">{peer.info.name}</span>
              <VolumeSlider
                volume={peer.audio.volume}
                muted={peer.audio.muted}
                onVolume={onVolume}
                onToggleMute={onToggleMute}
                label={peer.info.name}
                audible={peer.audible}
                hideMute
              />
            </div>
          </>
        )}

        <div className="tm-stage__spacer" />

        {siblings > 1 && (
          <button
            type="button"
            className="tm-stage__leave"
            onClick={onBackToGrid}
            title={`Ver as ${siblings} transmissões lado a lado`}
          >
            <IconGrid size={14} />
            Ver todas
          </button>
        )}

        <button
          type="button"
          className={`tm-iconbtn${mode === 'theater' ? ' is-active' : ''}`}
          onClick={toggleTheater}
          title="Modo teatro · T"
          aria-pressed={mode === 'theater'}
        >
          <IconTheater size={16} />
        </button>
        <button
          type="button"
          className="tm-iconbtn"
          onClick={toggleFullscreen}
          title={mode === 'fullscreen' ? 'Sair da tela cheia · Esc' : 'Tela cheia · F'}
        >
          {mode === 'fullscreen' ? <IconCollapse size={16} /> : <IconExpand size={16} />}
        </button>
      </div>

      {!live && peer && !showingLocal && (
        <div className="tm-stage__interrupted">
          <span className="tm-spinner" aria-hidden="true" />
          Reconectando
        </div>
      )}
    </div>
  )
}

/**
 * What is holding the picture back.
 *
 * Worth a line of its own because "soft picture" looks the same whether the
 * uplink is full or the encoder cannot keep up, and the two want opposite
 * fixes: more bandwidth, or less to encode.
 */
const LIMITATION_LABELS: Record<string, string> = {
  none: 'nenhum',
  cpu: 'processador',
  bandwidth: 'banda',
  other: 'outro'
}

function Row({
  label,
  value,
  warn = false
}: {
  label: string
  value: string
  warn?: boolean
}): JSX.Element {
  return (
    <div className="tm-stats__row">
      <span className="label">{label}</span>
      <span className={`num${warn ? ' is-warn' : ''}`}>{value}</span>
    </div>
  )
}
