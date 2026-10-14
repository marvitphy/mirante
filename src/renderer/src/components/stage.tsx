import { useCallback, useEffect, useRef, useState, type JSX } from 'react'

import {
  formatBitrate,
  formatElapsed,
  formatLoss,
  formatMs,
  formatResolution
} from '../lib/format'
import type { PeerView } from '../rtc/mesh-session'
import { IconCollapse, IconExpand, IconSignal, IconTheater } from './icons'
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
  mode: ViewMode
  chromeVisible: boolean
  onModeChange: (mode: ViewMode) => void
  onVolume: (volume: number) => void
  onToggleMute: () => void
  /** Pin the chrome open while a popover is on screen. */
  onHold: (held: boolean) => void
}

export function Stage({
  peer,
  localScreen,
  mode,
  chromeVisible,
  onModeChange,
  onVolume,
  onToggleMute,
  onHold
}: StageProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [showStats, setShowStats] = useState(false)
  const [, setClockTick] = useState(0)

  const stream = peer?.stream ?? localScreen
  const live = peer ? peer.link === 'live' : localScreen !== null

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

  const stats = peer?.stats
  const title = peer
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
          <span className="tm-stage__title">{title}</span>
          {peer && (
            <span className="tm-stage__elapsed num">{formatElapsed(peer.info.joinedAt)}</span>
          )}
        </div>

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
            label="caminho"
            value={stats.relayed ? 'TURN' : stats.candidateType || 'direto'}
            warn={stats.relayed}
          />
        </aside>
      )}

      <div className="tm-stage__bottom" data-visible={chromeVisible}>
        {peer && (
          <>
            <SignalMeter stats={peer.stats} live={live} variant="inline" />
            <div
              className="tm-stage__volume"
              onMouseEnter={() => onHold(true)}
              onMouseLeave={() => onHold(false)}
            >
              <VolumeSlider
                volume={peer.audio.volume}
                muted={peer.audio.muted}
                onVolume={onVolume}
                onToggleMute={onToggleMute}
                label={peer.info.name}
                audible={peer.audible}
              />
            </div>
          </>
        )}

        <div className="tm-stage__spacer" />

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

      {!live && peer && (
        <div className="tm-stage__interrupted">
          <span className="tm-spinner" aria-hidden="true" />
          Reconectando
        </div>
      )}
    </div>
  )
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
