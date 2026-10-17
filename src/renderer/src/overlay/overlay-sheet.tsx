import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type PointerEvent
} from 'react'

import { Avatar } from '../components/avatar'
import { IconClose, IconVolume, IconVolumeOff } from '../components/icons'
import type { PeerView } from '../rtc/mesh-session'
import { useFlip } from './use-flip'

/**
 * What you see over the game.
 *
 * Tiles live at anchors, never at loose coordinates. A sheet where anything
 * can sit anywhere sounds freer and is worse: tiles end up half off-screen,
 * over the crosshair, or in the one corner the scoreboard uses. Five anchors
 * cover every arrangement anyone actually wants, and a tile dropped anywhere
 * lands in the nearest — so the drag never has to be accurate.
 *
 * Freedom lives in the other two axes instead. Each tile has its own size
 * and can be dismissed outright, which is the control people actually reach
 * for: a face you want small and a broadcast you want big, both on screen,
 * and the one you do not care about gone.
 */

export type Anchor = 'tl' | 'tr' | 'bl' | 'br' | 'bc'

export const ANCHORS: Anchor[] = ['tl', 'tr', 'bl', 'br', 'bc']

/**
 * Tile width, in pixels, free between these bounds.
 *
 * Steps were the first attempt and felt like asking permission: three sizes,
 * none of them the one you wanted. Dragging a corner is the gesture people
 * already know from every window they have ever resized, and it costs
 * nothing to allow — the anchor keeps the tile pinned to its edge however
 * large it gets.
 */
const MIN_WIDTH = 96
const MAX_WIDTH = 520
const DEFAULT_FACE = 168
const DEFAULT_WIDE = 288

/** Which corner of the tile the resize handle sits on, per anchor. */
const HANDLE_CORNER: Record<Anchor, { x: 1 | -1; y: 1 | -1 }> = {
  // Always the corner pointing at the middle of the screen, so the tile
  // grows into empty space rather than off the edge it is pinned to.
  tl: { x: 1, y: 1 },
  tr: { x: -1, y: 1 },
  bl: { x: 1, y: -1 },
  br: { x: -1, y: -1 },
  bc: { x: 1, y: -1 }
}

const ANCHOR_LABELS: Record<Anchor, string> = {
  tl: 'superior esquerdo',
  tr: 'superior direito',
  bl: 'inferior esquerdo',
  br: 'inferior direito',
  bc: 'embaixo, ao centro'
}

/** Where each anchor's centre sits, as a fraction of the sheet. */
const ANCHOR_POINTS: Record<Anchor, { x: number; y: number }> = {
  tl: { x: 0.08, y: 0.1 },
  tr: { x: 0.92, y: 0.1 },
  bl: { x: 0.08, y: 0.9 },
  br: { x: 0.92, y: 0.9 },
  bc: { x: 0.5, y: 0.92 }
}

export interface OverlayTile {
  id: string
  name: string
  hue: number
  stream: MediaStream | null
  /** A shared screen is shown wider than a face. */
  wide: boolean
  mirrored?: boolean
  /** Your own tile is labelled, so you know which picture is yours. */
  mine?: boolean
  /** Set for someone else's tile, so their sound can be reached from here. */
  peerId?: string
  /** 0..2, their current level. */
  volume?: number
}

/**
 * Where a tile goes before anyone has moved it.
 *
 * Faces top-right, broadcasts bottom-left. Opposite corners, not the same
 * side: a face is a small square you glance at and a broadcast is a wide
 * rectangle you watch, so starting both on one side means the big one
 * covers the small one the first time they appear together.
 *
 * Only a default. The moment a tile is moved its position is remembered and
 * this never applies to it again.
 */
function defaultAnchor(tile: OverlayTile): Anchor {
  return tile.wide ? 'bl' : 'tr'
}

interface OverlaySheetProps {
  tiles: OverlayTile[]
  anchors: Record<string, Anchor>
  /** Width in pixels, keyed by tile id. */
  sizes: Record<string, number>
  /** Position within its corner, keyed by tile id. Lower is first. */
  order: Record<string, number>
  hidden: string[]
  interactive: boolean
  /** 0..1, applied while the sheet is passive. */
  opacity: number
  /** Whose broadcast audio is playing, if any. */
  listening: string | null
  /** Dropped into a corner, at a position within it. */
  onAnchor: (tileId: string, anchor: Anchor, index: number) => void
  onSize: (tileId: string, width: number) => void
  onHide: (tileId: string) => void
  onListen: (peerId: string | null) => void
  onVolume: (peerId: string, volume: number) => void
  onOpacity: (opacity: number) => void
  /** Put every dismissed tile back. */
  onRestore: () => void
  /** How to leave interactive mode, shown because there is no window to click away from. */
  exitHint: string
}

export function OverlaySheet({
  tiles,
  anchors,
  sizes,
  order,
  hidden,
  interactive,
  opacity,
  listening,
  onAnchor,
  onSize,
  onHide,
  onListen,
  onVolume,
  onOpacity,
  onRestore,
  exitHint
}: OverlaySheetProps): JSX.Element {
  const [dragging, setDragging] = useState<string | null>(null)
  /** Where the pointer is, and where inside the tile it grabbed. */
  const [drag, setDrag] = useState<{ x: number; y: number; dx: number; dy: number } | null>(
    null
  )
  const sheetRef = useRef<HTMLDivElement>(null)
  const dockRefs = useRef(new Map<Anchor, HTMLDivElement>())
  /** What each dock measures right now, while something is being dragged. */
  const [docks, setDocks] = useState<Partial<Record<Anchor, DOMRect>>>({})
  /**
   * Where the tiles already in each dock sit, so a drop can land BETWEEN
   * them rather than always at the end.
   *
   * Order inside a corner used to come from the order the room was built
   * in — every camera before its owner's screen — which meant a camera
   * could never be put above a broadcast sharing the same corner. The
   * arrangement was the app's, not the person's.
   */
  const [slots, setSlots] = useState<Partial<Record<Anchor, DOMRect[]>>>({})

  const shown = tiles.filter((tile) => !hidden.includes(tile.id))
  // The layout signature: who is on the sheet and where. Telemetry ticking
  // or a volume changing must not read as a layout change.
  const register = useFlip(
    shown.map((tile) => `${tile.id}@${anchors[tile.id] ?? defaultAnchor(tile)}`).join('|')
  )

  /** The anchor whose point is closest to where the cursor is now. */
  const nearest = useCallback((x: number, y: number): Anchor => {
    const node = sheetRef.current
    const width = node?.clientWidth ?? window.innerWidth
    const height = node?.clientHeight ?? window.innerHeight

    let best: Anchor = 'br'
    let bestDistance = Infinity
    for (const anchor of ANCHORS) {
      const point = ANCHOR_POINTS[anchor]
      const dx = x - point.x * width
      const dy = y - point.y * height
      const distance = dx * dx + dy * dy
      if (distance < bestDistance) {
        bestDistance = distance
        best = anchor
      }
    }
    return best
  }, [])

  const target = drag ? nearest(drag.x, drag.y) : null

  /**
   * Measure the docks while a tile is in the air.
   *
   * The drop targets should say what the result will LOOK like, not just
   * where it will go. A corner that already holds two tiles needs a taller
   * target than an empty one, and a target drawn at a fixed size next to a
   * stack it cannot contain is telling a small lie about what is about to
   * happen.
   */
  useEffect(() => {
    if (!dragging) {
      setDocks({})
      return
    }
    const next: Partial<Record<Anchor, DOMRect>> = {}
    const children: Partial<Record<Anchor, DOMRect[]>> = {}
    for (const [anchor, node] of dockRefs.current) {
      next[anchor] = node.getBoundingClientRect()
      // The dragged tile is already out of flow by now, so what is measured
      // is exactly what the drop has to fit around.
      children[anchor] = [...node.children].map((child) => child.getBoundingClientRect())
    }
    setDocks(next)
    setSlots(children)
  }, [dragging])

  /**
   * Which position in a corner the cursor is pointing at.
   *
   * Corners stack downward, so it is a question about Y; the bottom centre
   * is a row, so there it is about X. Either way: how many of the tiles
   * already there does the cursor sit past.
   */
  const insertionAt = useCallback(
    (anchor: Anchor, x: number, y: number): number => {
      const rects = slots[anchor] ?? []
      let index = 0
      for (const rect of rects) {
        const past =
          anchor === 'bc' ? x > rect.left + rect.width / 2 : y > rect.top + rect.height / 2
        if (!past) break
        index++
      }
      return index
    },
    [slots]
  )

  /** The size a zone should be to hold what is there plus what is coming. */
  const zoneSize = (anchor: Anchor): { width: number; height: number } => {
    const tile = shown.find((candidate) => candidate.id === dragging)
    const incomingWidth = tile
      ? (sizes[tile.id] ?? (tile.wide ? DEFAULT_WIDE : DEFAULT_FACE))
      : DEFAULT_FACE
    const incomingHeight = (incomingWidth * 9) / 16

    const dock = docks[anchor]
    const padding = 24
    // Corners stack downward; the bottom centre grows sideways.
    if (anchor === 'bc') {
      return {
        width: (dock?.width ?? 0) + incomingWidth + padding,
        height: Math.max(dock?.height ?? 0, incomingHeight) + padding
      }
    }
    return {
      width: Math.max(dock?.width ?? 0, incomingWidth) + padding,
      height: (dock?.height ?? 0) + incomingHeight + padding
    }
  }

  const startDrag = (event: PointerEvent<HTMLDivElement>, tileId: string): void => {
    if (!interactive) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)

    // Keep the grab point under the finger. Snapping the tile's centre to
    // the cursor makes it jump the instant you touch it, which reads as the
    // app taking the tile away from you rather than you picking it up.
    const box = event.currentTarget.getBoundingClientRect()
    setDragging(tileId)
    setDrag({
      x: event.clientX,
      y: event.clientY,
      dx: event.clientX - (box.left + box.width / 2),
      dy: event.clientY - (box.top + box.height / 2)
    })
  }

  const moveDrag = (event: PointerEvent<HTMLDivElement>): void => {
    if (!drag) return
    setDrag({ ...drag, x: event.clientX, y: event.clientY })
  }

  const endDrag = (event: PointerEvent<HTMLDivElement>): void => {
    if (!dragging) return
    const anchor = nearest(event.clientX, event.clientY)
    onAnchor(dragging, anchor, insertionAt(anchor, event.clientX, event.clientY))
    setDragging(null)
    setDrag(null)
  }

  // A drag interrupted by the sheet going passive — the shortcut pressed
  // mid-drag — must not leave a tile stuck to a cursor nobody can see.
  useEffect(() => {
    if (!interactive) {
      setDragging(null)
      setDrag(null)
    }
  }, [interactive])

  return (
    <div
      ref={sheetRef}
      className={`tm-ov${interactive ? ' is-live' : ''}${dragging ? ' is-dragging' : ''}`}
      style={{ opacity: interactive ? 1 : opacity }}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {/* Where a tile can land. Drawn only while something is in the air —
          an idle sheet should show the game, not a diagram of itself. */}
      {/* The only chrome the sheet has, and only while it is holding the
          mouse. Transparency belongs here rather than in a settings modal:
          a modal covers the very thing you are trying to see through. */}
      {interactive && !dragging && (
        <div className="tm-ov__bar">
          <span className="tm-ov__bar-label">transparência</span>
          <input
            className="tm-ov__bar-range"
            type="range"
            min={0.2}
            max={1}
            step={0.05}
            value={opacity}
            onChange={(event) => onOpacity(Number(event.target.value))}
          />
          <span className="tm-ov__bar-value num">{Math.round(opacity * 100)}%</span>

          {hidden.length > 0 && (
            <button type="button" className="tm-ov__bar-btn" onClick={onRestore}>
              Trazer de volta ({hidden.length})
            </button>
          )}

          <span className="tm-ov__bar-exit">{exitHint} pra sair</span>
        </div>
      )}

      {ANCHORS.map((anchor, index) => {
        const fit = dragging ? zoneSize(anchor) : null
        return (
          <div
            key={`zone-${anchor}`}
            className={`tm-ov__zone tm-ov__zone--${anchor}${
              target === anchor ? ' is-target' : ''
            }${dragging ? ' is-open' : ''}`}
            style={{
              transitionDelay: dragging ? `${index * 18}ms` : '0ms',
              // The target grows to the shape of the result; the others stay
              // small, so the one that is about to happen is obvious without
              // reading anything.
              width: fit && target === anchor ? fit.width : undefined,
              height: fit && target === anchor ? fit.height : undefined
            }}
            aria-hidden="true"
          >
            <span>{ANCHOR_LABELS[anchor]}</span>
          </div>
        )
      })}

      {ANCHORS.map((anchor) => {
        const here = shown
          .filter((tile) => (anchors[tile.id] ?? defaultAnchor(tile)) === anchor)
          // A tile nobody has placed keeps the order the room gave it, which
          // is why `index` is the fallback rather than zero.
          .map((tile, index) => ({ tile, at: order[tile.id] ?? index + 1000 }))
          .sort((a, b) => a.at - b.at)
          .map((entry) => entry.tile)

        const insertAt =
          dragging && drag && target === anchor
            ? insertionAt(anchor, drag.x, drag.y)
            : null

        if (here.length === 0 && insertAt === null) return null
        return (
          <div
            key={anchor}
            ref={(node) => {
              if (node) dockRefs.current.set(anchor, node)
              else dockRefs.current.delete(anchor)
            }}
            className={`tm-ov__dock tm-ov__dock--${anchor}`}
          >
            {here.map((tile, index) => (
              <Fragment key={tile.id}>
                {insertAt === index && <span className="tm-ov__caret" aria-hidden="true" />}
                <Tile
                key={tile.id}
                tile={tile}
                width={sizes[tile.id] ?? (tile.wide ? DEFAULT_WIDE : DEFAULT_FACE)}
                register={register}
                flipKey={`${tile.id}:${anchors[tile.id] ?? ''}`}
                anchor={anchor}
                drag={dragging === tile.id ? drag : null}
                interactive={interactive}
                hearing={tile.peerId !== undefined && listening === tile.peerId}
                onPointerDown={(event) => startDrag(event, tile.id)}
                onSize={(width) => onSize(tile.id, width)}
                onHide={() => onHide(tile.id)}
                onListen={() => {
                  if (tile.peerId) onListen(listening === tile.peerId ? null : tile.peerId)
                }}
                onVolume={(volume) => {
                  if (tile.peerId) onVolume(tile.peerId, volume)
                }}
                />
              </Fragment>
            ))}
            {insertAt !== null && insertAt >= here.length && (
              <span className="tm-ov__caret" aria-hidden="true" />
            )}
          </div>
        )
      })}
    </div>
  )
}

function Tile({
  tile,
  width,
  anchor,
  register,
  flipKey,
  drag,
  interactive,
  hearing,
  onPointerDown,
  onSize,
  onHide,
  onListen,
  onVolume
}: {
  tile: OverlayTile
  width: number
  anchor: Anchor
  register: (key: string, node: HTMLElement | null) => void
  flipKey: string
  drag: { x: number; y: number; dx: number; dy: number } | null
  interactive: boolean
  hearing: boolean
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void
  onSize: (width: number) => void
  onHide: () => void
  onListen: () => void
  onVolume: (volume: number) => void
}): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const tileRef = useRef<HTMLDivElement | null>(null)

  // Resize by dragging the inner corner, the way every window works.
  const resize = (event: PointerEvent<HTMLSpanElement>): void => {
    event.preventDefault()
    event.stopPropagation()
    const start = event.clientX
    const from = width
    const sign = HANDLE_CORNER[anchor].x
    const node = event.currentTarget
    node.setPointerCapture(event.pointerId)

    const move = (move_: globalThis.PointerEvent): void => {
      const next = from + sign * (move_.clientX - start)
      onSize(Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next))))
    }
    const done = (): void => {
      node.removeEventListener('pointermove', move)
      node.removeEventListener('pointerup', done)
      node.removeEventListener('pointercancel', done)
    }
    node.addEventListener('pointermove', move)
    node.addEventListener('pointerup', done)
    node.addEventListener('pointercancel', done)
  }

  // The wheel sets their level, the same gesture as the slider in the app.
  // Bound natively because React registers wheel as passive, and a passive
  // listener cannot stop the sheet scrolling underneath it.
  useEffect(() => {
    const node = tileRef.current
    if (!node || !interactive || tile.peerId === undefined) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const step = event.deltaY < 0 ? 0.05 : -0.05
      onVolume(Math.min(2, Math.max(0, (tile.volume ?? 1) + step)))
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [interactive, onVolume, tile.peerId, tile.volume])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (video.srcObject !== tile.stream) {
      video.srcObject = tile.stream
      if (tile.stream) void video.play().catch(() => undefined)
    }
  }, [tile.stream])

  // While dragging the tile leaves its dock and follows the cursor, keeping
  // the point you grabbed under the pointer.
  const floating = drag
    ? {
        position: 'fixed' as const,
        left: drag.x - drag.dx,
        top: drag.y - drag.dy,
        transform: 'translate(-50%, -50%)',
        zIndex: 10
      }
    : undefined

  return (
    <div
      ref={(node) => {
        tileRef.current = node
        register(flipKey, node)
      }}
      className={`tm-ov__tile${tile.wide ? ' is-wide' : ''}${drag ? ' is-held' : ''}${
        interactive ? ' is-grabbable' : ''
      }`}
      style={{ width, ...floating }}
      onPointerDown={onPointerDown}
      title={interactive ? `Arraste ${tile.name} para um canto` : tile.name}
    >
      {tile.stream ? (
        <video
          ref={videoRef}
          className={`tm-ov__video${tile.mirrored ? ' is-mirrored' : ''}`}
          autoPlay
          playsInline
          muted
        />
      ) : (
        <Avatar name={tile.name} hue={tile.hue} />
      )}

      <span className="tm-ov__name">{tile.mine ? 'você' : tile.name}</span>

      {/* Reachable only where it can be used. In the passive sheet these
          would be decoration over someone's game. */}
      {interactive && !drag && (
        <>
          <div className="tm-ov__tools" onPointerDown={(event) => event.stopPropagation()}>
            {tile.peerId !== undefined && (
              <button
                type="button"
                className={`tm-ov__tool${hearing ? ' is-on' : ''}`}
                onClick={onListen}
                aria-pressed={hearing}
                title={
                  hearing
                    ? `Silenciar ${tile.name} · role pra ajustar`
                    : `Ouvir ${tile.name} · role pra ajustar`
                }
              >
                {hearing ? <IconVolume size={12} /> : <IconVolumeOff size={12} />}
              </button>
            )}
            <button
              type="button"
              className="tm-ov__tool"
              onClick={onHide}
              title="Tirar do overlay — continua na janela do Mirante"
            >
              <IconClose size={12} />
            </button>
          </div>

          {/* The level, drawn only while it is not the default, so a row of
              tiles is not a row of progress bars. */}
          {hearing && (tile.volume ?? 1) !== 1 && (
            <span className="tm-ov__level" aria-hidden="true">
              <span style={{ width: `${Math.min(100, ((tile.volume ?? 1) / 2) * 100)}%` }} />
            </span>
          )}

          <span
            className={`tm-ov__grip tm-ov__grip--${anchor}`}
            onPointerDown={resize}
            title="Arraste pra redimensionar"
          />
        </>
      )}
    </div>
  )
}

/** Build the tiles from the room, in a stable order. */
export function tilesFromRoom(
  peers: PeerView[],
  localCamera: MediaStream | null,
  localScreen: MediaStream | null,
  mirrorSelf: boolean,
  selfName: string,
  selfHue: number
): OverlayTile[] {
  const tiles: OverlayTile[] = []

  if (localCamera) {
    tiles.push({
      id: 'self-camera',
      name: selfName,
      hue: selfHue,
      stream: localCamera,
      wide: false,
      mirrored: mirrorSelf,
      mine: true
    })
  }
  if (localScreen) {
    tiles.push({
      id: 'self-screen',
      name: `${selfName} · tela`,
      hue: selfHue,
      stream: localScreen,
      wide: true,
      mine: true
    })
  }

  for (const peer of peers) {
    if (peer.camera) {
      tiles.push({
        id: `${peer.info.id}:camera`,
        name: peer.info.name,
        hue: peer.info.hue,
        stream: peer.camera,
        wide: false,
        peerId: peer.info.id,
        volume: peer.audio.volume
      })
    }
    if (peer.screen) {
      tiles.push({
        id: `${peer.info.id}:screen`,
        name: `${peer.info.name} · tela`,
        hue: peer.info.hue,
        stream: peer.screen,
        wide: true,
        peerId: peer.info.id,
        volume: peer.audio.volume
      })
    }
  }

  return tiles
}
