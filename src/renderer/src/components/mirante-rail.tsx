import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'

import type { AudioMixer } from '../rtc/audio-mixer'
import type { PeerView } from '../rtc/mesh-session'
import { IconMic, IconMicOff, IconScreen, IconVolume, IconVolumeOff } from './icons'
import { formatVolume } from '../lib/format'
import { SignalMeter } from './signal-meter'
import { VolumeSlider } from './volume-slider'

/**
 * The guarda-corpo — the lookout railing.
 *
 * Everyone in the room leans on it along the bottom of the stage. Each tile
 * carries a camera (or an initial), a live audio level ring, and a signal
 * meter. Click a tile to put that person on the stage; click the speaker to
 * tune only them.
 *
 * Signature of the product: telemetry as ornament. You can see who is talking,
 * who is struggling and who is sharing without reading a single number.
 *
 * Self and peers render through ONE `Tile`. They used to be two components,
 * which is why they did not line up — and the self version was a `<button>`
 * acting as a flex container, which Chromium lays out through an anonymous
 * content box and pushed the avatar off centre. The clickable element is now
 * always a child, never the box itself.
 */

interface MiranteRailProps {
  peers: PeerView[]
  selfName: string
  selfHue: number
  localCamera: MediaStream | null
  micOn: boolean
  focused: string | null
  /** Fades in lockstep with the stage chrome. */
  visible: boolean
  /** Show your own camera as a mirror, the way a mirror behaves. */
  mirrorSelf: boolean
  /** Bottom floats over the video; right takes a column of its own. */
  position: 'bottom' | 'right'
  mixer: AudioMixer
  onFocus: (peerId: string | null) => void
  onVolume: (peerId: string, volume: number) => void
  onToggleMute: (peerId: string) => void
  /** Your own microphone. The tile's mic icon is a control, not a readout. */
  onToggleMic: () => void
}

export function MiranteRail({
  peers,
  selfName,
  selfHue,
  localCamera,
  micOn,
  focused,
  visible,
  mirrorSelf,
  position,
  mixer,
  onFocus,
  onVolume,
  onToggleMute,
  onToggleMic
}: MiranteRailProps): JSX.Element {
  return (
    <div
      className={`tm-rail tm-rail--${position}`}
      // A column of its own is always there; a strip over the video comes and
      // goes with the rest of the player chrome.
      data-visible={position === 'right' ? true : visible}
      role="list"
      aria-label="Pessoas na sala"
    >
      {position === 'right' && (
        <div className="tm-rail__head">
          <span className="label">Na sala</span>
          <span className="tm-rail__count num">{peers.length + 1}</span>
        </div>
      )}
      <Tile
        name={selfName}
        hue={selfHue}
        stream={localCamera}
        mirrored={mirrorSelf}
        active={focused === null}
        label="Sua prévia"
        onFocus={() => onFocus(null)}
        corner={<span className="tm-tile__self-mark label">você</span>}
        slot={
          // Clickable, not decorative. An icon that looks like a button and
          // does nothing is worse than no icon: it teaches people that the
          // controls here are unreliable.
          <button
            type="button"
            className={`tm-tile__slot tm-tile__slot--button${micOn ? '' : ' is-off'}`}
            onClick={(event) => {
              event.stopPropagation()
              onToggleMic()
            }}
            title={micOn ? 'Desligar seu microfone' : 'Ligar seu microfone'}
          >
            {micOn ? <IconMic size={13} /> : <IconMicOff size={13} />}
          </button>
        }
      />

      {peers.map((peer) => (
        <PeerTile
          key={peer.info.id}
          peer={peer}
          mixer={mixer}
          active={focused === peer.info.id}
          onFocus={() => onFocus(peer.info.id)}
          onVolume={(volume) => onVolume(peer.info.id, volume)}
          onToggleMute={() => onToggleMute(peer.info.id)}
        />
      ))}

    </div>
  )
}

// ---------------------------------------------------------------------------

interface TileProps {
  name: string
  hue: number
  stream: MediaStream | null
  active: boolean
  label: string
  onFocus: () => void
  /** Right-hand element of the foot. Every tile reserves this slot, so names
      line up across the rail whatever the tile is showing. */
  slot: ReactNode
  /** Overlay pinned inside the frame, e.g. the "você" mark or a share badge. */
  corner?: ReactNode
  mirrored?: boolean
  children?: ReactNode
}

function Tile({
  name,
  hue,
  stream,
  active,
  label,
  onFocus,
  slot,
  corner,
  mirrored = false,
  children
}: TileProps): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (video.srcObject !== stream) {
      video.srcObject = stream
      if (stream) void video.play().catch(() => undefined)
    }
  }, [stream])

  return (
    <div role="listitem" className={`tm-tile${active ? ' is-active' : ''}`}>
      {/* Layout lives on this plain div. A <button> must never be the flex
          container here: Chromium lays a button's children out through an
          anonymous content box, which stops the frame stretching and pushed
          the avatar off centre. The button is a transparent hit layer. */}
      <div className="tm-tile__frame">
        {stream ? (
          <video
            ref={videoRef}
            className={`tm-tile__video${mirrored ? ' is-mirrored' : ''}`}
            autoPlay
            playsInline
            muted
          />
        ) : (
          <Avatar name={name} hue={hue} />
        )}
        {corner}
      </div>

      <div className="tm-tile__foot">
        <span className="tm-tile__name">{name}</span>
        {slot}
      </div>

      <button type="button" className="tm-tile__hit" onClick={onFocus} title={label}>
        <span className="tm-sr">{label}</span>
      </button>

      {children}
    </div>
  )
}

function PeerTile({
  peer,
  mixer,
  active,
  onFocus,
  onVolume,
  onToggleMute
}: {
  peer: PeerView
  mixer: AudioMixer
  active: boolean
  onFocus: () => void
  onVolume: (volume: number) => void
  onToggleMute: () => void
}): JSX.Element {
  const ringRef = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)
  const live = peer.link === 'live'
  // Anything other than "normal, audible" stays visible without hovering, so
  // you can see that you turned someone down three days ago.
  const touched = peer.audible && (peer.audio.muted || peer.audio.volume !== 1)

  // Audio level ring, driven by rAF straight from the analyser and written to
  // the DOM — never through state, so a talking friend does not re-render the
  // whole rail sixty times a second.
  useEffect(() => {
    if (!live) return
    let frame = 0
    const paint = (): void => {
      const node = ringRef.current
      if (node) node.style.opacity = mixer.level(peer.info.id) > 0.04 ? '1' : '0'
      frame = requestAnimationFrame(paint)
    }
    frame = requestAnimationFrame(paint)
    return () => cancelAnimationFrame(frame)
  }, [live, mixer, peer.info.id])

  return (
    <Tile
      name={peer.info.name}
      hue={peer.info.hue}
      stream={peer.camera}
      active={active}
      label={`Ver ${peer.info.name}`}
      onFocus={onFocus}
      corner={
        peer.state.screen ? (
          <span className="tm-tile__badge" title="Transmitindo a tela">
            <IconScreen size={12} />
          </span>
        ) : undefined
      }
      slot={<SignalMeter stats={peer.stats} live={live} />}
    >
      <span ref={ringRef} className="tm-tile__ring" aria-hidden="true" />

      {/* A SPEAKER, never a microphone. This changes how loud they are in YOUR
          ears only — a mic icon reads as "mute their microphone for everyone",
          which is a completely different and much scarier action. */}
      <button
        type="button"
        className={`tm-tile__volume-toggle${touched ? ' is-touched' : ''}${
          peer.audio.muted ? ' is-muted' : ''
        }`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={
          peer.audio.muted
            ? `${peer.info.name} está mudo só pra você`
            : `Volume de ${peer.info.name} — só pra você (${formatVolume(peer.audio.volume)})`
        }
      >
        {peer.audio.muted ? <IconVolumeOff size={13} /> : <IconVolume size={13} />}
      </button>

      {open && (
        <div className="tm-tile__popover" onMouseLeave={() => setOpen(false)}>
          <span className="label">
            {peer.info.name} · só pra você
          </span>
          <VolumeSlider
            volume={peer.audio.volume}
            muted={peer.audio.muted}
            onVolume={onVolume}
            onToggleMute={onToggleMute}
            label={peer.info.name}
            audible={peer.audible}
          />
        </div>
      )}
    </Tile>
  )
}

function Avatar({ name, hue }: { name: string; hue: number }): JSX.Element {
  const initial = name.trim().charAt(0).toUpperCase() || '?'
  return (
    <span
      className="tm-avatar"
      style={{
        // Hue comes from the peer id, so one person looks the same to everyone
        // in the room. Lightness and saturation are fixed, so no avatar ever
        // out-shouts the stage.
        background: `hsl(${hue} 40% 24%)`,
        color: `hsl(${hue} 70% 80%)`
      }}
    >
      {initial}
    </span>
  )
}
