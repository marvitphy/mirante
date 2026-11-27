/**
 * Mirante signaling protocol.
 *
 * Verb set is modelled on the TeamSpeak 6 teardown in docs/teamspeak-rtc-teardown.md:
 * their entire A/V signaling is five verbs — offer / answer / iceCandidate /
 * joinResponse / reconnectOffer — carried as Matrix room events.
 *
 * Two things borrowed deliberately:
 *   - `joinResponse` fuses admission control and the SDP offer into one message,
 *     saving a round trip on join.
 *   - `reconnectOffer` is a first-class verb, so a network blip resumes a session
 *     instead of tearing it down and rejoining.
 */

export const PROTOCOL_VERSION = 1

/** Stable identity of a participant for the lifetime of one connection. */
export type PeerId = string
export type RoomId = string

export interface PeerInfo {
  id: PeerId
  /**
   * Who this is across reconnects — the same value the client sent in `hello`.
   *
   * The server already replaces a session carrying a clientId it has seen, so
   * in principle no room ever holds two of the same person. In practice the
   * correction travels as a `peerLeft` broadcast, and a broadcast is a thing
   * that can be missed: one person saw the room clean while another saw the
   * same user twice, from the same server state.
   *
   * Publishing it makes the invariant checkable by every client on its own,
   * instead of being something each of them has to be successfully told.
   */
  clientId: string
  name: string
  /** Deterministic hue (0-359) derived from the id, so a peer looks the same to everyone. */
  hue: number
  joinedAt: number
}

/**
 * One open room, as the entrance sees it.
 *
 * A room here is not a record anywhere — it exists exactly as long as
 * someone is standing in it. So this is a census, not a directory: nothing
 * is created, nothing is reserved, and an empty room stops existing without
 * anyone deleting it.
 */
export interface ChatPayload {
  from: PeerId
  /** Stable across reconnects, so a client recognises its own older messages. */
  clientId: string
  /**
   * Author as they were when they wrote it. The id changes on reconnect and
   * the peer may leave before anyone reads the message, so the name travels
   * with the text instead of being looked up in the room.
   */
  name: string
  hue: number
  text: string
  at: number
}

export interface LobbyPerson {
  name: string
  /** The same hue they will have inside, so a face is the same face. */
  hue: number
}

export interface LobbyRoom {
  id: RoomId
  /**
   * Who is in there.
   *
   * People, not a count. "Joacy e dellannu" is a reason to walk in; "2
   * pessoas" is a statistic — and carrying the hue means the entrance can
   * draw the same faces the room will.
   */
  people: LobbyPerson[]
  /** Whether anyone in there is sharing a screen. The reason to join. */
  live: boolean
  /**
   * WHAT is on, when the publisher said.
   *
   * "ao vivo" tells you a room is worth opening; the window title tells you
   * whether it is worth opening to YOU. The publishers already send this so
   * viewers can label the stage — it costs nothing to carry it one step
   * further, to the people deciding whether to walk in.
   */
  showing?: string
  /** When the room came into being, so it can say how long it has been going. */
  since: number
}

/** What is happening on this server right now. */
export interface LobbySnapshot {
  rooms: LobbyRoom[]
  /** Everyone, across every room. */
  people: number
  /** Server clock, so a client can tell a stale snapshot from a quiet night. */
  at: number
}

/** What a peer is currently publishing. Drives the stage layout. */
export interface PeerPublishState {
  screen: boolean
  camera: boolean
  mic: boolean
  /**
   * O que a pessoa esta fazendo fora do Mirante, pelo nome do programa em
   * primeiro plano.
   *
   * Viaja junto do estado de publicacao porque usa o mesmo caminho: muda
   * de vez em quando, e todo mundo na sala precisa saber. Criar um verbo
   * proprio para isso seria duplicar um broadcast que ja existe.
   *
   * Ausente quando o Mirante esta em foco — "esta usando o Mirante" nao e
   * atividade — e quando a pessoa desligou isso.
   */
  activity?: string
  /**
   * Icone do programa, como data URL de 16px.
   *
   * Vai junto porque reconhecer um jogo pelo icone e instantaneo e ler o
   * nome nao e. Sao uns 2 KB, e so viaja quando a atividade MUDA — e ela
   * so muda quando a pessoa fica de verdade em outro programa.
   */
  activityIcon?: string
  /** Set when the peer is sharing a screen: lets viewers label the stage. */
  screenLabel?: string
  /**
   * MediaStream ids, so a viewer can tell the screen from the camera.
   *
   * Both arrive as video tracks and nothing in the RTP layer says which is
   * which. Guessing by arrival order meant that turning on a camera while
   * already sharing put the camera on the stage and pushed the screen into
   * the little tile — the two swapped depending on which track landed last.
   */
  screenStreamId?: string
  cameraStreamId?: string
}

export type PublishKind = 'screen' | 'camera' | 'mic'

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

export type ClientMessage =
  | {
      t: 'hello'
      version: number
      room: RoomId
      name: string
      /**
       * Who you are across reconnects.
       *
       * The peer id is minted per connection, so a client that drops and
       * comes back arrives as a stranger — and if the server has not yet
       * noticed the old socket died, the room shows the same person twice.
       * This stays the same for the life of the app window, which lets the
       * server REPLACE the previous session instead of adding to it.
       */
      clientId: string
    }
  | { t: 'publishState'; state: PeerPublishState }
  /** Room-wide text. The server fills in the author from the connection. */
  | { t: 'chat'; text: string }
  /** Ask a publisher for its stream. The publisher answers with `joinResponse`. */
  | { t: 'join'; to: PeerId }
  | { t: 'leaveStream'; to: PeerId }
  /**
   * Whether we want this publisher's PICTURE. Their voice always comes.
   *
   * Leaving someone's broadcast must not deafen them — in a room built for
   * watching things together, you always want to hear your friends and only
   * sometimes want to see their screen. So the link stays up for audio and
   * only the video slots are gated, which also hands the publisher back a
   * full copy of their upload for every viewer who stepped out.
   */
  | { t: 'watchVideo'; to: PeerId; video: boolean }
  | { t: 'signal'; to: PeerId; dir: StreamDir; payload: SignalPayload }
  | { t: 'ping'; ts: number }
  /**
   * Leaving on purpose. Without this the server only learns you left when the
   * TCP connection drops, which is asynchronous and can easily arrive AFTER
   * your next join — leaving a ghost copy of you in the room.
   */
  | { t: 'bye' }

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

export type ServerMessage =
  | {
      t: 'welcome'
      self: PeerInfo
      peers: Array<PeerInfo & { state: PeerPublishState }>
      iceServers: RTCIceServerConfig[]
    }
  | { t: 'peerJoined'; peer: PeerInfo; state: PeerPublishState }
  | { t: 'peerLeft'; id: PeerId }
  | { t: 'peerState'; id: PeerId; state: PeerPublishState }
  | ({ t: 'chat' } & ChatPayload)
  | { t: 'join'; from: PeerId }
  | { t: 'leaveStream'; from: PeerId }
  | { t: 'watchVideo'; from: PeerId; video: boolean }
  | { t: 'signal'; from: PeerId; dir: StreamDir; payload: SignalPayload }
  | { t: 'pong'; ts: number }
  | { t: 'error'; code: string; message: string }

// ---------------------------------------------------------------------------
// The five signaling verbs, carried inside `signal`
// ---------------------------------------------------------------------------

/**
 * Structural stand-ins for the DOM WebRTC types.
 *
 * This module is imported by both the renderer (DOM available) and the Node
 * signaling server (no DOM lib). Declaring the shapes here keeps the contract
 * in one file instead of pulling `lib.dom` into the server build. They are
 * assignable to and from the real DOM types.
 */
export interface SessionDescription {
  type: 'offer' | 'answer' | 'pranswer' | 'rollback'
  sdp?: string
}

export interface IceCandidate {
  candidate?: string
  sdpMid?: string | null
  sdpMLineIndex?: number | null
  usernameFragment?: string | null
}

/**
 * Which stream a signaling message is about, from the SENDER's point of view.
 *
 * In a mesh both peers can publish at once, so there are two independent
 * PeerConnections between any pair — one per direction. Without this tag an
 * `iceCandidate` is ambiguous and ends up applied to the wrong connection,
 * which silently breaks the moment two people share simultaneously.
 *
 * The receiver flips it: a message marked `out` concerns the sender's outbound
 * stream, which is the receiver's inbound (viewer) link, and vice versa.
 */
export type StreamDir = 'out' | 'in'

export type SignalPayload =
  /** Admission + offer in one message. `decision:false` means the publisher refused. */
  | { cmd: 'joinResponse'; decision: boolean; offer?: SessionDescription; reason?: string }
  | { cmd: 'offer'; offer: SessionDescription }
  | { cmd: 'answer'; answer: SessionDescription }
  | { cmd: 'iceCandidate'; candidate: IceCandidate }
  /** ICE restart on an existing session rather than a teardown + rejoin. */
  | { cmd: 'reconnectOffer'; offer: SessionDescription }

/** Mirrors RTCIceServer but stays serialisable across the wire and IPC. */
export interface RTCIceServerConfig {
  urls: string | string[]
  username?: string
  credential?: string
}

// ---------------------------------------------------------------------------
// Helpers shared by both ends
// ---------------------------------------------------------------------------

/** Deterministic hue from an id so every client renders a peer identically. */
export function hueFromId(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return h % 360
}

export function emptyPublishState(): PeerPublishState {
  return { screen: false, camera: false, mic: false }
}
