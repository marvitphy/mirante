import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'

import type { AudioMixer } from '../rtc/audio-mixer'
import { micLevel } from '../rtc/mic-chain'
import type { PeerView } from '../rtc/mesh-session'
import { Avatar } from './avatar'
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
  /** Whether you are sharing a screen, which outranks a camera in the list. */
  selfSharing: boolean
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
  selfSharing,
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
  /**
   * Order by what someone is doing, not by when they arrived.
   *
   * A list sorted by join time puts whoever happened to connect first at the
   * top and leaves the person who just turned their camera on buried at the
   * bottom. The column exists to show who is here and what they are up to,
   * so the people doing something are the people to show first: a screen
   * share outranks a camera, a camera outranks neither, and inside a tier
   * the original order holds so nothing shuffles for no reason.
   *
   * Your own tile takes part in the same rule rather than being pinned. With
   * your camera off you are the least eventful thing in the room, and
   * sitting at the top of a list of friends who are visibly doing something
   * is not a privilege worth keeping.
   */
  const rank = (sharing: boolean, camera: boolean): number =>
    sharing ? 0 : camera ? 1 : 2

  const rows = [
    {
      key: 'self',
      rank: rank(selfSharing, localCamera !== null),
      at: 0,
      node: (
        <Tile
          key="self"
          name={selfName}
          hue={selfHue}
          stream={localCamera}
          mirrored={mirrorSelf}
          active={focused === null}
          label="Sua prévia"
          onFocus={() => onFocus(null)}
          level={micOn ? micLevel : undefined}
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
      )
    },
    ...peers.map((peer) => ({
      key: peer.info.id,
      rank: rank(peer.state.screen, peer.state.camera),
      at: peer.info.joinedAt,
      node: (
        <PeerTile
          key={peer.info.id}
          peer={peer}
          mixer={mixer}
          active={focused === peer.info.id}
          onFocus={() => onFocus(peer.info.id)}
          onVolume={(volume) => onVolume(peer.info.id, volume)}
          onToggleMute={() => onToggleMute(peer.info.id)}
        />
      )
    }))
  ]
    .sort((a, b) => a.rank - b.rank || a.at - b.at)
    .map((row) => row.node)

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
      {rows}

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
  /**
   * Turn this person up or down with the wheel, over the tile itself.
   *
   * The same gesture the overlay and the sliders already use. A row of
   * faces is the most obvious place in the app to reach for someone's
   * volume, and until now it was the one place that did not answer.
   */
  onAdjust?: (delta: number) => void
  /**
   * Where that wheel has left them, 0..2.
   *
   * Drawn across the tile for a moment after it moves, then gone. Without
   * it the gesture is a guess: the sound changes, but by how much, how far
   * from where it was, and how much further it can go are all invisible —
   * and on a muted or silent friend nothing happens at all, which reads as
   * a broken control rather than as a quiet one.
   */
  adjusted?: number
  /**
   * How loud this person is right now, 0..1, polled every frame.
   *
   * A getter rather than a value, because a number would mean re-rendering
   * the whole rail sixty times a second to animate one ring.
   *
   * This lives on `Tile` and not on `PeerTile` so that your own tile gets
   * it too. It used to be PeerTile's alone, which is why everyone in the
   * room lit up when they spoke and you never did — the one person who
   * cannot hear themselves was also the one with no indication that their
   * microphone was working.
   */
  level?: () => number
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
  onAdjust,
  adjusted,
  level,
  children
}: TileProps): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const tileRef = useRef<HTMLDivElement | null>(null)
  const ringRef = useRef<HTMLSpanElement>(null)
  // Held in a ref so a caller passing an inline arrow does not restart the
  // animation loop on every render.
  const levelRef = useRef(level)
  levelRef.current = level
  const adjustRef = useRef(onAdjust)
  adjustRef.current = onAdjust
  const scrubRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (video.srcObject !== stream) {
      video.srcObject = stream
      if (stream) void video.play().catch(() => undefined)
    }
  }, [stream])

  // Bound natively, because React registers wheel listeners as passive and
  // a passive listener cannot call preventDefault — the volume would move
  // and the rail would scroll out from under the cursor at the same time.
  const adjustable = onAdjust !== undefined
  useEffect(() => {
    const node = tileRef.current
    if (!node || !adjustable) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      adjustRef.current?.(event.deltaY < 0 ? 0.05 : -0.05)
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [adjustable])

  // Show the bar when the value moves, then take it away. Mounting is not a
  // move: a rail of tiles all flashing their volume on arrival would be
  // noise, and the bar means "this just changed".
  const first = useRef(true)
  useEffect(() => {
    // Nothing to show, and the next value that arrives is an arrival rather
    // than a change. Without this reset, a friend who mutes and unmutes
    // comes back with their volume bar flashing at a gesture nobody made.
    if (adjusted === undefined) {
      first.current = true
      return
    }
    if (first.current) {
      first.current = false
      return
    }
    const node = scrubRef.current
    if (!node) return
    node.dataset.on = 'true'
    const timer = window.setTimeout(() => {
      node.dataset.on = 'false'
    }, 900)
    return () => window.clearTimeout(timer)
  }, [adjusted])

  // Driven by rAF straight from the analyser and written to the DOM — never
  // through state, so a talking friend does not re-render the whole rail.
  const metered = level !== undefined
  useEffect(() => {
    if (!metered) return
    let frame = 0
    const paint = (): void => {
      const node = ringRef.current
      const read = levelRef.current
      if (node && read) node.style.opacity = read() > 0.04 ? '1' : '0'
      frame = requestAnimationFrame(paint)
    }
    frame = requestAnimationFrame(paint)
    return () => cancelAnimationFrame(frame)
  }, [metered])

  return (
    <div
      ref={tileRef}
      role="listitem"
      className={`tm-tile${active ? ' is-active' : ''}${adjustable ? ' is-adjustable' : ''}`}
    >
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

      {metered && <span ref={ringRef} className="tm-tile__ring" aria-hidden="true" />}
      {adjusted !== undefined && (
        <div ref={scrubRef} className="tm-tile__scrub" data-on="false" aria-hidden="true">
          <span className="tm-tile__scrub-value num">{formatVolume(adjusted)}</span>
          <span className="tm-tile__scrub-track">
            <span
              className="tm-tile__scrub-fill"
              // Half is 1.0, so the midpoint of the bar is "normal" and a
              // boost is visibly past it rather than merely further along.
              data-boost={adjusted > 1}
              style={{ transform: `scaleY(${Math.min(1, adjusted / 2)})` }}
            />
          </span>
        </div>
      )}
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
  const [open, setOpen] = useState(false)
  const live = peer.link === 'live'
  // Broadcasting, but we are not receiving it. An offer, not a picture — and
  // deliberately NOT the red tally, which means "you are on air".
  const inviting = !peer.watching && peer.state.screen
  // Anything other than "normal, audible" stays visible without hovering, so
  // you can see that you turned someone down three days ago.
  const touched = peer.audible && (peer.audio.muted || peer.audio.volume !== 1)

  return (
    <Tile
      name={peer.info.name}
      hue={peer.info.hue}
      stream={peer.camera}
      active={active}
      level={live ? () => mixer.level(peer.info.id) : undefined}
      adjusted={peer.audible ? peer.audio.volume : undefined}
      label={inviting ? `Assistir ${peer.info.name}` : `Ver ${peer.info.name}`}
      onFocus={onFocus}
      onAdjust={
        peer.audible
          ? (delta) => onVolume(Math.min(2, Math.max(0, peer.audio.volume + delta)))
          : undefined
      }
      corner={
        peer.state.screen ? (
          <span
            className={`tm-tile__badge${inviting ? ' is-inviting' : ''}`}
            title={
              inviting
                ? `${peer.info.name} está transmitindo — clique pra assistir`
                : 'Transmitindo a tela'
            }
          >
            <IconScreen size={12} />
          </span>
        ) : undefined
      }
      slot={<SignalMeter stats={peer.stats} live={live} />}
    >

      {inviting && (
        <span className="tm-tile__invite" aria-hidden="true">
          {peer.frozen ? (
            <img className="tm-tile__frozen" src={peer.frozen} alt="" />
          ) : null}
          <span className="tm-tile__invite-label label">ao vivo</span>
        </span>
      )}

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

