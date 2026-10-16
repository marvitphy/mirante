import { useEffect, useRef, type JSX } from 'react'

import { formatMs } from '../lib/format'
import type { PeerView } from '../rtc/mesh-session'
import { IconSolo, IconVolume, IconVolumeOff } from './icons'
import { VolumeSlider } from './volume-slider'

/**
 * Several broadcasts at once.
 *
 * The room can have more than one thing worth watching, and making people
 * choose one at a time turns "look at this" into a negotiation. So every
 * broadcast you joined gets a panel, and the panels divide the stage.
 *
 * Clicking one fills the stage with it — not fullscreen, which is a different
 * and heavier gesture. Fullscreen hides the room; filling keeps everyone
 * where they are and just stops dividing the space.
 *
 * Four is the ceiling, and it is a bandwidth ceiling rather than a layout
 * one: in a mesh each broadcast you watch is a full copy of someone's upload,
 * and a fifth simultaneous stream costs more than the fifth panel is worth.
 */

/** Panels past this are not rendered; the room is a mesh, not a video wall. */
export const MAX_PANELS = 4

interface StageGridProps {
  peers: PeerView[]
  /**
   * Your own broadcast, which gets a panel like anyone else's.
   *
   * Leaving it out was a mistake with a simple cause — it is not a peer — and
   * a real cost: the person broadcasting could not see their own picture
   * while watching others, which is exactly when you most want to confirm
   * that what you are sending is the thing you meant to send.
   */
  localStream: MediaStream | null
  localWatchers: number
  /** Whose broadcast you can hear, if any. */
  listening: string | null
  /** Hear this one instead, or `null` for none. */
  onListen: (peerId: string | null) => void
  /** Fill the stage with one of them. `null` means your own. */
  onExpand: (peerId: string | null) => void
  onVolume: (peerId: string, volume: number) => void
  onToggleMute: (peerId: string) => void
}

export function StageGrid({
  peers,
  localStream,
  localWatchers,
  listening,
  onListen,
  onExpand,
  onVolume,
  onToggleMute
}: StageGridProps): JSX.Element {
  // Yours first. It is the one you can act on, and a fixed position means it
  // does not move under the cursor when someone else joins or leaves.
  const room = localStream ? MAX_PANELS - 1 : MAX_PANELS
  const shown = peers.slice(0, room)
  const total = shown.length + (localStream ? 1 : 0)

  return (
    <div className="tm-stage tm-grid" data-count={total} aria-label={`${total} transmissões`}>
      {localStream && (
        <LocalPanel
          stream={localStream}
          watchers={localWatchers}
          onExpand={() => onExpand(null)}
        />
      )}
      {shown.map((peer) => (
        <Panel
          key={peer.info.id}
          peer={peer}
          hearing={listening === peer.info.id}
          onListen={() => onListen(listening === peer.info.id ? null : peer.info.id)}
          onExpand={() => onExpand(peer.info.id)}
          onVolume={(volume) => onVolume(peer.info.id, volume)}
          onToggleMute={() => onToggleMute(peer.info.id)}
        />
      ))}
    </div>
  )
}

/**
 * Your own broadcast, as a panel.
 *
 * Deliberately not a `Panel` with the peer fields left blank: there is no
 * latency to your own screen, no volume of yours to set, and nobody to leave.
 * What belongs here instead is the one thing only you need to know — whether
 * anybody is actually watching.
 */
function LocalPanel({
  stream,
  watchers,
  onExpand
}: {
  stream: MediaStream
  watchers: number
  onExpand: () => void
}): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (video.srcObject !== stream) {
      video.srcObject = stream
      void video.play().catch(() => undefined)
    }
  }, [stream])

  return (
    <div className="tm-panel tm-panel--mine">
      <video ref={videoRef} className="tm-panel__video" playsInline autoPlay muted />

      <button
        type="button"
        className="tm-panel__hit"
        onClick={onExpand}
        title="Preencher a tela com a sua transmissão"
      >
        <span className="tm-panel__expand" aria-hidden="true">
          <IconSolo size={16} />
        </span>
      </button>

      <div className="tm-panel__bar">
        <span className="tm-panel__who">Você</span>
        <span className={`tm-audience${watchers === 0 ? ' is-empty' : ''}`}>
          {watchers === 0 ? 'ninguém assistindo' : `${watchers} assistindo`}
        </span>
      </div>
    </div>
  )
}

function Panel({
  peer,
  hearing,
  onListen,
  onExpand,
  onVolume,
  onToggleMute
}: {
  peer: PeerView
  hearing: boolean
  onListen: () => void
  onExpand: () => void
  onVolume: (volume: number) => void
  onToggleMute: () => void
}): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const stream = peer.screen ?? peer.camera
  const live = peer.link === 'live'

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (video.srcObject !== stream) {
      video.srcObject = stream
      if (stream) void video.play().catch(() => undefined)
    }
  }, [stream])

  const title = peer.state.screenLabel ?? `Tela de ${peer.info.name}`

  return (
    <div className="tm-panel">
      {/* Muted, always: every remote stream's sound goes through the mixer so
          each person has one volume. An unmuted element here would play the
          same audio a second time, slightly out of step with itself. */}
      <video ref={videoRef} className="tm-panel__video" playsInline autoPlay muted />

      {!live && (
        <div className="tm-panel__waiting">
          <span className="tm-spinner" aria-hidden="true" />
        </div>
      )}

      {/* The whole panel is the target for filling the stage. The controls
          below sit above it and stop the click, so adjusting someone's volume
          never also rearranges the layout. */}
      <button
        type="button"
        className="tm-panel__hit"
        onClick={onExpand}
        title={`Preencher a tela com ${peer.info.name}`}
      >
        <span className="tm-panel__expand" aria-hidden="true">
          <IconSolo size={16} />
        </span>
      </button>

      <div className="tm-panel__bar" onClick={(event) => event.stopPropagation()}>
        <span className="tm-panel__who" title={title}>
          {peer.info.name}
        </span>
        <span className="tm-panel__ping num">{formatMs(peer.stats.rttMs)}</span>

        {/* Which broadcast you are listening to. Several pictures at once is
            useful; several soundtracks at once is noise, so exactly one of
            these is ever lit. */}
        <button
          type="button"
          className={`tm-panel__listen${hearing ? ' is-on' : ''}`}
          onClick={onListen}
          aria-pressed={hearing}
          title={
            hearing
              ? `Você está ouvindo ${peer.info.name} — clique pra silenciar`
              : `Ouvir o som de ${peer.info.name}`
          }
        >
          {hearing ? <IconVolume size={13} /> : <IconVolumeOff size={13} />}
        </button>
        <VolumeSlider
          volume={peer.audio.volume}
          muted={peer.audio.muted}
          onVolume={onVolume}
          onToggleMute={onToggleMute}
          label={peer.info.name}
          audible={peer.audible}
          compact
        />
      </div>
    </div>
  )
}
