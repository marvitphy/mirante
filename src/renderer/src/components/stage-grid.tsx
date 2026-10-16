import { useEffect, useRef, type JSX } from 'react'

import { formatMs } from '../lib/format'
import type { PeerView } from '../rtc/mesh-session'
import { IconMaximize } from './icons'
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
  /** Fill the stage with one of them. */
  onExpand: (peerId: string) => void
  onVolume: (peerId: string, volume: number) => void
  onToggleMute: (peerId: string) => void
}

export function StageGrid({
  peers,
  onExpand,
  onVolume,
  onToggleMute
}: StageGridProps): JSX.Element {
  const shown = peers.slice(0, MAX_PANELS)

  return (
    <div
      className="tm-stage tm-grid"
      data-count={shown.length}
      aria-label={`${shown.length} transmissões`}
    >
      {shown.map((peer) => (
        <Panel
          key={peer.info.id}
          peer={peer}
          onExpand={() => onExpand(peer.info.id)}
          onVolume={(volume) => onVolume(peer.info.id, volume)}
          onToggleMute={() => onToggleMute(peer.info.id)}
        />
      ))}
    </div>
  )
}

function Panel({
  peer,
  onExpand,
  onVolume,
  onToggleMute
}: {
  peer: PeerView
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
          <IconMaximize size={14} />
        </span>
      </button>

      <div className="tm-panel__bar" onClick={(event) => event.stopPropagation()}>
        <span className="tm-panel__who" title={title}>
          {peer.info.name}
        </span>
        <span className="tm-panel__ping num">{formatMs(peer.stats.rttMs)}</span>
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
