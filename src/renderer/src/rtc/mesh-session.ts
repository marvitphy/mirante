import {
  emptyPublishState,
  type SessionDescription,
  type PeerInfo,
  type PeerPublishState,
  type RTCIceServerConfig,
  type ServerMessage,
  type SignalPayload,
  type StreamDir
} from '../../../shared/protocol'
import { soundJoin, soundLeave, soundLiveEnd, soundLiveStart } from '../lib/sounds'
import { AudioMixer, type PeerAudio } from './audio-mixer'
import {
  EMPTY_STATS,
  PeerLink,
  type LinkState,
  type LinkStats,
  type SlotName
} from './peer-link'
import { SCREEN_PROFILES, setContentHint, type ScreenProfileName } from './sdp'
import { clientId } from '../lib/client-id'
import { Signaling, type SignalingStatus } from './signaling'

/**
 * How long a viewer link may stay down before we rebuild it from scratch.
 *
 * Long enough for the publisher's ICE restarts to land first — rebuilding is
 * a visible interruption, restarting is not.
 */
const REJOIN_AFTER_MS = 45_000

/** How long to wait for a `joinResponse` before asking again. */
const JOIN_RETRY_MS = 10_000

/** The slots that carry sound, in the order the mixer should receive them. */
const AUDIO_SLOTS: SlotName[] = ['screenAudio', 'mic']

/**
 * Upload governor.
 *
 * A mesh publisher sends one full copy of its screen to every viewer, so the
 * uplink is the scarce thing — and nothing in WebRTC knows the total: each
 * PeerConnection runs its own congestion control and happily believes it has
 * the whole link to itself. Something has to own the sum.
 *
 * The old answer was arithmetic: the profile ceiling divided by the viewer
 * count. That is wrong in both directions at once. On a thin uplink, three
 * viewers still oversubscribe it; on fibre it pins a single viewer to a
 * quarter of what the line could carry and never finds out otherwise. Which
 * is why a game came through as mush.
 *
 * This measures instead. It starts deliberately low, raises the budget while
 * round-trip time and loss stay healthy, and backs off hard the moment they
 * do not. Climbing slowly and falling fast is the whole trick: buffer bloat
 * is a cliff, and 19 seconds of it is a far worse outcome than a soft picture.
 */
const BUDGET_START = 3_000_000
const BUDGET_MIN = 1_000_000
/** Ceiling for ONE viewer's stream. */
const BUDGET_MAX = 20_000_000

/**
 * Ceiling for everything leaving this machine at once.
 *
 * The only genuinely shared limit. Per-viewer budgets are earned
 * independently and only get scaled down when their sum would exceed this.
 */
const UPLINK_TOTAL_MAX = 24_000_000
/**
 * Ceiling while any viewer is reached through a TURN relay.
 *
 * A relay is the one path that costs money and the one path whose capacity is
 * not ours, so it earns a lower ceiling. It does NOT earn the right to
 * override the quality someone picked — that is what used to happen, and it
 * is why "Nitido" silently became "Economico" and stayed there: the override
 * latched and never let go, even once the path went direct again. Quality is
 * the person's choice; how much bandwidth it gets is ours.
 */
const BUDGET_MAX_RELAYED = 3_000_000
/** How often the budget is reconsidered. */
const GOVERNOR_INTERVAL_MS = 3_000
/** Healthy samples in a row before asking for more. */
const GOVERNOR_PATIENCE = 2
const RTT_HEALTHY_MS = 150
const RTT_STRAINED_MS = 400
const LOSS_HEALTHY = 0.02
const LOSS_STRAINED = 0.05

/**
 * Mesh session — the one place that knows the topology.
 *
 * Named after the lesson in docs/teamspeak-rtc-teardown.md §5b: TeamSpeak has
 * `StreamBase` with `StreamP2P` and `StreamSFU` underneath it, and picks at
 * runtime. We ship only the mesh, but everything above this class talks to the
 * session, never to a PeerConnection. Swapping in an SFU later is a change to
 * this file and nothing else.
 *
 * Honest ceiling: mesh upstream is O(N). Encoding once (see PeerLink) fixes the
 * CPU, but a 8 Mbit/s share to five viewers still needs 40 Mbit/s of upload,
 * which no home connection has. The server caps rooms accordingly.
 */

export interface RemoteStream {
  peerId: string
  stream: MediaStream
  hasVideo: boolean
  hasAudio: boolean
}

export interface PeerView {
  info: PeerInfo
  state: PeerPublishState
  link: LinkState
  stats: LinkStats
  audio: PeerAudio
  /** False when they are sending no audio at all — the control says so. */
  audible: boolean
  /** Their shared screen, if any. This is what belongs on the stage. */
  screen: MediaStream | null
  /** Their camera, if any. This belongs in their tile, next to their name. */
  camera: MediaStream | null
  /** One stream per slot, built from the tracks as they arrive. */
  streams: Map<SlotName, MediaStream>
  /**
   * Whether we are actually receiving this person's broadcast.
   *
   * Someone going live is news, not an instruction. Being yanked into a
   * stream the moment a friend starts one is startling, costs bandwidth
   * nobody asked to spend, and in a mesh it costs the BROADCASTER a full
   * extra copy of their upload per viewer. So watching is something you
   * choose — with one exception, in `shouldAutoWatch`.
   */
  watching: boolean
  /**
   * The last frame seen before leaving their stream, as a data URL.
   *
   * Leaving really does stop the media — that is the point. A frozen frame
   * keeps the tile from going to a black rectangle, and shows what you would
   * be returning to.
   */
  frozen: string | null
}

export interface LocalPublish {
  screen: MediaStream | null
  camera: MediaStream | null
  mic: MediaStream | null
  screenLabel: string | null
  profile: ScreenProfileName
  /** How many people currently have our picture open. Derived, not stored. */
  watchers: number
}

export interface SessionSnapshot {
  status: SignalingStatus
  /** Whose broadcast you can hear, if any. */
  listening: string | null
  self: PeerInfo | null
  peers: PeerView[]
  local: LocalPublish
  /** Peer id whose stream is on the stage, or null for the local preview. */
  focused: string | null
  error: string | null
  /** True when any media path fell back to a TURN relay. */
  anyRelayed: boolean
}

type Listener = () => void

export class MeshSession {
  /**
   * This window's identity, stable across reconnects but distinct per
   * window — two instances on one machine are genuinely two participants.
   */
  private readonly clientId = clientId()
  private signaling: Signaling | null = null
  private iceServers: RTCIceServerConfig[] = []
  /**
   * Two connections per peer, not one. In a mesh both sides can publish at the
   * same time, so the link we send media over and the link we receive media
   * over are independent PeerConnections. Keying them by peer id alone made
   * the second one overwrite the first the moment two people shared together.
   */
  private readonly publishers = new Map<string, PeerLink>()
  private readonly viewers = new Map<string, PeerLink>()
  /**
   * Candidates that arrive before their link exists. A publisher starts
   * trickling the instant it builds an offer, which on a LAN is before the
   * viewer has built its side — and those first host candidates are the best
   * ones we will ever get.
   */
  private readonly earlyCandidates = new Map<string, RTCIceCandidateInit[]>()
  /** Pending automatic rejoin for a viewer link that will not come back. */
  private readonly rejoinTimers = new Map<string, number>()
  /** Pending re-ask for a `join` that was never answered. */
  private readonly joinRetries = new Map<string, number>()
  /**
   * Viewers who have stepped out of the picture but still hear us.
   *
   * Video is the expensive half and the half people choose; audio is neither.
   */
  private readonly videoMuted = new Set<string>()
  /** What each viewer has earned, in bits per second, keyed by peer id. */
  private readonly budgets = new Map<string, number>()
  /** Consecutive healthy samples per viewer, before asking for more. */
  private readonly streaks = new Map<string, number>()
  private governorTimer: number | null = null
  private readonly peers = new Map<string, PeerView>()
  private readonly mixer = new AudioMixer()
  private readonly listeners = new Set<Listener>()

  private self: PeerInfo | null = null
  private status: SignalingStatus = 'idle'
  private error: string | null = null
  private focused: string | null = null
  private local: LocalPublish = {
    screen: null,
    camera: null,
    mic: null,
    screenLabel: null,
    profile: 'smooth',
    watchers: 0
  }

  /** Set once per session, so a manual profile change is not fought over. */

  /**
   * How many people have our picture open.
   *
   * Since joining a broadcast became a choice, going live no longer means
   * being seen. Without this the broadcaster cannot tell an audience of four
   * from an audience of nobody — and talking to an empty room is a worse
   * experience than the surprise that opt-in replaced.
   */
  private watcherCount(): number {
    if (this.local.screen === null && this.local.camera === null) return 0
    let count = 0
    for (const peerId of this.publishers.keys()) {
      if (!this.videoMuted.has(peerId)) count++
    }
    return count
  }

  /** Whose broadcast audio is playing. Voices are never gated by this. */
  private listening: string | null = null

  private snapshot: SessionSnapshot = this.buildSnapshot()

  // --- React integration --------------------------------------------------

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): SessionSnapshot => this.snapshot

  private buildSnapshot(): SessionSnapshot {
    const peers = [...this.peers.values()].sort(
      (a, b) => a.info.joinedAt - b.info.joinedAt
    )
    return {
      status: this.status,
      self: this.self,
      peers,
      local: { ...this.local, watchers: this.watcherCount() },
      focused: this.focused,
      listening: this.listening,
      error: this.error,
      anyRelayed: peers.some((p) => p.stats.relayed)
    }
  }

  private emit(): void {
    this.snapshot = this.buildSnapshot()
    for (const listener of this.listeners) listener()
  }

  get audioMixer(): AudioMixer {
    return this.mixer
  }

  // --- lifecycle ----------------------------------------------------------

  connect(url: string, room: string, name: string): void {
    this.disconnect()
    this.error = null
    this.signaling = new Signaling({
      // The room goes in the path because the Cloudflare worker routes to a
      // Durable Object by URL — one object per room IS the room. The Node dev
      // server ignores the path and reads the room from `hello` instead, so
      // the same client works against both.
      url: `${url.replace(/\/+$/, '')}/room/${encodeURIComponent(room)}`,
      clientId: this.clientId,
      room,
      name,
      onStatus: (status) => {
        this.status = status
        this.emit()
      },
      onMessage: (message) => void this.handle(message)
    })
    this.signaling.connect()
    this.governorTimer = window.setInterval(
      () => this.governUpload(),
      GOVERNOR_INTERVAL_MS
    )
    this.emit()
  }

  disconnect(): void {
    if (this.governorTimer !== null) {
      window.clearInterval(this.governorTimer)
      this.governorTimer = null
    }
    this.budgets.clear()
    this.streaks.clear()
    for (const link of this.allLinks()) link.close()
    this.publishers.clear()
    this.viewers.clear()
    this.earlyCandidates.clear()
    this.peers.clear()
    this.mixer.dispose()
    this.signaling?.close()
    this.signaling = null
    this.self = null
    this.focused = null
    this.emit()
  }

  // --- signaling ----------------------------------------------------------

  private send(to: string, dir: StreamDir, payload: SignalPayload): void {
    this.signaling?.send({ t: 'signal', to, dir, payload })
  }

  private allLinks(): PeerLink[] {
    return [...this.publishers.values(), ...this.viewers.values()]
  }

  /**
   * One person, one row — enforced here rather than hoped for.
   *
   * The server replaces a session whose clientId it has already seen and
   * announces it with `peerLeft`. That announcement is a broadcast, and a
   * broadcast can go missing: the symptom was one person seeing a clean room
   * while someone else, in the same room at the same moment, saw the same
   * user listed twice. No amount of care on the server fixes a message that
   * did not arrive, so the rule is checked locally too.
   *
   * The newest session wins, because it is the one with a live socket.
   */
  private collapseDuplicates(): void {
    const newest = new Map<string, PeerView>()
    const doomed: string[] = []

    for (const peer of this.peers.values()) {
      const key = peer.info.clientId
      // An older build sends no clientId; it cannot be de-duplicated and must
      // not be collapsed against anyone else who also lacks one.
      if (!key) continue

      const held = newest.get(key)
      if (!held) {
        newest.set(key, peer)
        continue
      }
      const stale = held.info.joinedAt <= peer.info.joinedAt ? held : peer
      newest.set(key, stale === held ? peer : held)
      doomed.push(stale.info.id)
    }

    for (const id of doomed) {
      console.warn(`[mesh] descartando copia duplicada de ${id}`)
      this.dropLinks(id)
      this.mixer.detach(id)
      this.peers.delete(id)
      if (this.focused === id) this.focused = null
    }
  }

  private dropLinks(peerId: string): void {
    this.cancelRejoin(peerId)
    this.cancelJoinRetry(peerId)
    this.publishers.get(peerId)?.close()
    this.viewers.get(peerId)?.close()
    this.publishers.delete(peerId)
    this.viewers.delete(peerId)
    this.earlyCandidates.delete(peerId + ':out')
    this.earlyCandidates.delete(peerId + ':in')
  }

  private async handle(message: ServerMessage): Promise<void> {
    switch (message.t) {
      case 'welcome': {
        this.self = message.self
        this.iceServers = message.iceServers
        for (const peer of message.peers) {
          this.peers.set(peer.id, this.blankPeer(peer, peer.state))
        }
        this.collapseDuplicates()
        this.emit()
        // Connect to everyone who is publishing, always: that is how their
        // VOICE arrives, and you never opt out of hearing your friends.
        for (const peer of message.peers) {
          if (peer.state.screen || peer.state.camera || peer.state.mic) {
            this.requestStream(peer.id)
          }
        }

        // Say what WE are publishing, every time.
        //
        // The server builds a session with an empty publish state and learns
        // the rest from `publishState` messages, which a client only sends
        // when something changes. That is fine for a first connection and
        // wrong for every reconnection: after a network blip — or after the
        // signalling worker is redeployed, which evicts the room object and
        // drops every socket at once — everyone came back announcing
        // nothing. Four people connected, no cameras, no screens, nothing on
        // the stage, and no way out but restarting. The state was never lost
        // locally; it simply was never said again.
        this.announce()

        // Walking in shows you everything already happening — a room you
        // just entered should not be a list of invitations to things you
        // cannot see. What it does not do is play any of it: sound is the
        // part you point at, one broadcast at a time.
        for (const peer of this.peers.values()) {
          if (peer.state.screen || peer.state.camera) this.watch(peer.info.id)
        }
        break
      }

      case 'peerJoined': {
        this.peers.set(message.peer.id, this.blankPeer(message.peer, message.state))
        this.collapseDuplicates()
        // Deliberately not fired for the `welcome` list: arriving to a room
        // of four people should not play four sounds at once.
        soundJoin()
        this.emit()
        break
      }

      case 'peerLeft': {
        soundLeave()
        this.dropLinks(message.id)
        this.mixer.detach(message.id)
        this.peers.delete(message.id)
        if (this.focused === message.id) this.focused = null
        this.emit()
        break
      }

      case 'peerState': {
        const peer = this.peers.get(message.id)
        if (!peer) break
        const wasPublishing = peer.state.screen || peer.state.camera || peer.state.mic
        const wasSharing = peer.state.screen
        peer.state = message.state
        if (!wasSharing && message.state.screen) soundLiveStart()
        if (wasSharing && !message.state.screen) soundLiveEnd()
        const nowPublishing = message.state.screen || message.state.camera || message.state.mic

        // Going live is announced, not imposed. The sound and the badge
        // already said so; whether to watch is the viewer's call, except in
        // the quiet-room case.
        // Everything happening in the room is on the stage. Deciding
        // whether to SEE each broadcast turned out to be a choice nobody
        // wanted to make: it left people looking at cards instead of
        // pictures and produced a different answer on every screen. The
        // only choice worth offering is which one you can hear.
        if (!wasPublishing && nowPublishing) {
          // Was there anything on the stage before this? Only then does a
          // new broadcast get to fill it. Otherwise it arrives as what it
          // is — a sound, a badge, and a panel in the grid — and whoever
          // was mid-way through watching something stays there.
          const stageWasEmpty = !this.anythingLive(message.id)
          this.requestStream(message.id)
          this.watch(message.id)
          if (stageWasEmpty) this.focused = message.id
        }
        if (wasPublishing && !nowPublishing) {
          this.cancelRejoin(message.id)
          this.viewers.get(message.id)?.close()
          this.viewers.delete(message.id)
          this.earlyCandidates.delete(message.id + ':out')
          this.mixer.detach(message.id)
          peer.audible = false
          peer.streams.clear()
          peer.screen = null
          peer.camera = null
          peer.link = 'closed'
          peer.watching = false
          peer.frozen = null
          if (this.focused === message.id) this.focused = null
          if (this.listening === message.id) this.listenTo(null)
        }
        // A slot that is switched off keeps its transceiver and its track —
        // that is the whole point of fixed slots, and why turning a camera off
        // no longer interrupts the screen share. But the track stops producing
        // frames, so a <video> still bound to it freezes on black. The
        // announced state is the only authority on what is actually live, so
        // the visible handles follow it: cleared when the slot goes quiet,
        // restored from the cached stream when it comes back. No renegotiation
        // either way.
        if (!message.state.screen) peer.screen = null
        else peer.screen ??= peer.streams.get('screen') ?? null

        if (!message.state.camera) peer.camera = null
        else peer.camera ??= peer.streams.get('camera') ?? null

        // Nothing left to look at — don't hold the stage on an empty picture.
        if (this.focused === message.id && !peer.screen && !peer.camera) {
          this.focused = null
        }

        // Auto-promote the first screen share to the stage. Nobody should have
        // to hunt for the thing they came to watch.
        if (message.state.screen && peer.watching && this.focused === null) {
          this.focused = message.id
        }
        this.emit()
        break
      }

      // Someone wants our stream. Admission + offer in one reply, the way
      // TeamSpeak's `joinResponse` does it — saves a round trip.
      case 'join': {
        await this.publishTo(message.from)
        break
      }

      case 'watchVideo': {
        if (message.video) this.videoMuted.delete(message.from)
        else this.videoMuted.add(message.from)
        const link = this.publishers.get(message.from)
        if (link) await this.syncLink(link)
        break
      }

      case 'leaveStream': {
        this.publishers.get(message.from)?.close()
        this.publishers.delete(message.from)
        break
      }

      case 'signal': {
        await this.handleSignal(message.from, message.dir, message.payload)
        break
      }

      case 'error': {
        this.error = message.message
        this.emit()
        break
      }

      default:
        break
    }
  }

  private blankPeer(info: PeerInfo, state: PeerPublishState): PeerView {
    return {
      info,
      state,
      link: 'new',
      stats: { ...EMPTY_STATS },
      audio: this.mixer.peerAudio(info.id),
      audible: false,
      screen: null,
      camera: null,
      streams: new Map(),
      watching: false,
      frozen: null
    }
  }

  /**
   * Route a signaling message to the right connection.
   *
   * `dir` is the sender's view of the media, so it flips here: their `out` is
   * our viewer link, their `in` is our publisher link.
   */
  private async handleSignal(
    from: string,
    dir: StreamDir,
    payload: SignalPayload
  ): Promise<void> {
    switch (payload.cmd) {
      case 'joinResponse': {
        if (!payload.decision || !payload.offer) {
          const peer = this.peers.get(from)
          if (peer) {
            peer.link = 'closed'
            this.emit()
          }
          return
        }
        await this.answerOffer(from, payload.offer, true)
        break
      }

      case 'offer':
        // A plain offer is a RENEGOTIATION over the existing connection —
        // someone added or removed a track. Rebuilding here would undo the
        // entire point of renegotiating.
        await this.answerOffer(from, payload.offer, false)
        break

      case 'reconnectOffer':
        // An ICE restart reuses the existing connection; replacing it would
        // throw away the very session we are trying to resume.
        await this.answerOffer(from, payload.offer, false)
        break

      case 'answer':
        await this.publishers.get(from)?.acceptAnswer(payload.answer)
        break

      case 'iceCandidate': {
        const link = dir === 'out' ? this.viewers.get(from) : this.publishers.get(from)
        if (link) {
          await link.addCandidate(payload.candidate)
        } else {
          // Hold it until the link exists rather than dropping it on the floor.
          const key = from + ':' + dir
          const queue = this.earlyCandidates.get(key) ?? []
          queue.push(payload.candidate)
          this.earlyCandidates.set(key, queue)
        }
        break
      }
    }
  }

  /**
   * Answer an inbound offer on our viewer link.
   *
   * `fresh` replaces any existing connection. A brand new offer means the
   * publisher rebuilt its PeerConnection with new ICE credentials and a new
   * DTLS fingerprint; reusing our old one against it fails, which is what
   * broke every viewer whenever a publisher toggled camera or microphone.
   * An ICE restart is the exception — it must keep the same connection.
   */
  private async answerOffer(
    from: string,
    offer: SessionDescription,
    fresh: boolean
  ): Promise<void> {
    if (fresh) {
      this.viewers.get(from)?.close()
      this.viewers.delete(from)
    }

    const link = this.ensureViewerLink(from)
    const answer = await link.acceptOffer(offer)
    this.send(from, 'in', { cmd: 'answer', answer })
  }

  // --- links --------------------------------------------------------------

  private makeLink(peerId: string, role: 'publisher' | 'viewer'): PeerLink {
    // Our outbound media is the publisher link; our inbound is the viewer one.
    const dir: StreamDir = role === 'publisher' ? 'out' : 'in'
    return new PeerLink({
      peerId,
      role,
      iceServers: this.iceServers,
      send: (payload) => this.send(peerId, dir, payload),
      onTrack: (slot, track) => {
        const peer = this.peers.get(peerId)
        if (!peer) return

        // One stream per slot. The slot IS the identity, so the screen can
        // never end up where the camera belongs.
        let stream = peer.streams.get(slot)
        if (!stream) {
          stream = new MediaStream()
          peer.streams.set(slot, stream)
        }
        if (!stream.getTracks().includes(track)) stream.addTrack(track)

        if (slot === 'screen') peer.screen = stream
        if (slot === 'camera') peer.camera = stream

        if (track.kind === 'audio') {
          // Both audio slots feed one per-person volume control: from the
          // listener's side, "how loud is this person" is a single question.
          // They go in together — handing them over one at a time made the
          // second one evict the first.
          this.attachAudio(peer)
        }

        if (this.focused === null && slot === 'screen' && peer.watching) {
          this.focused = peerId
        }
        this.emit()
      },
      onState: (state) => {
        const peer = this.peers.get(peerId)
        if (!peer || peer.link === state) return
        peer.link = state
        if (role === 'viewer') {
          if (state === 'interrupted') this.scheduleRejoin(peerId)
          else this.cancelRejoin(peerId)
          if (state === 'live' || state === 'connecting') this.cancelJoinRetry(peerId)
        }
        this.emit()
      },
      onStats: (stats) => {
        const peer = this.peers.get(peerId)
        if (!peer) return
        peer.stats = stats
        this.emit()
      }
    })
  }

  private ensureViewerLink(peerId: string): PeerLink {
    let link = this.viewers.get(peerId)
    if (!link) {
      link = this.makeLink(peerId, 'viewer')
      this.viewers.set(peerId, link)
      void this.flushCandidates(peerId + ':out', link)
    }
    return link
  }

  private async flushCandidates(key: string, link: PeerLink): Promise<void> {
    const queue = this.earlyCandidates.get(key)
    if (!queue) return
    this.earlyCandidates.delete(key)
    for (const candidate of queue) await link.addCandidate(candidate)
  }

  /** Ask `peerId` to send us their stream. */
  /**
   * Last resort for a viewer link that stays down: ask for the stream again.
   *
   * An ICE restart is the publisher's to make, so a viewer whose link dies has
   * nothing of its own to try — which is why the only cure used to be leaving
   * the room and coming back. This is that rejoin, performed automatically:
   * drop the dead link and send a fresh `join`, which makes the publisher
   * build a new connection from scratch.
   *
   * The delay is long enough that an ICE restart gets to finish first. This
   * should almost never be the thing that fixes it.
   */
  private scheduleRejoin(peerId: string): void {
    if (this.rejoinTimers.has(peerId)) return

    const timer = window.setTimeout(() => {
      this.rejoinTimers.delete(peerId)
      const peer = this.peers.get(peerId)
      if (!peer || peer.link === 'live' || peer.link === 'closed') return
      if (!peer.state.screen && !peer.state.camera && !peer.state.mic) return
      // Still interrupted after all this time, and the publisher's ICE
      // restarts have had many attempts by now. Only here is rebuilding
      // cheaper than waiting.
      if (peer.link !== 'interrupted') return

      console.warn(`[rtc] ${peerId}: link nao voltou, pedindo o stream de novo`)
      this.viewers.get(peerId)?.close()
      this.viewers.delete(peerId)
      this.earlyCandidates.delete(peerId + ':out')
      this.mixer.detach(peerId)
      peer.audible = false
      peer.streams.clear()
      peer.screen = null
      peer.camera = null
      peer.link = 'connecting'
      this.emit()
      this.requestStream(peerId)
    }, REJOIN_AFTER_MS)

    this.rejoinTimers.set(peerId, timer)
  }

  private scheduleJoinRetry(peerId: string): void {
    const existing = this.joinRetries.get(peerId)
    if (existing !== undefined) window.clearTimeout(existing)

    const timer = window.setTimeout(() => {
      this.joinRetries.delete(peerId)
      const peer = this.peers.get(peerId)
      if (!peer) return
      // A link exists, whatever shape it is in. Asking again would only make
      // the publisher rebuild it, and a rebuild is a visible interruption
      // where an ICE restart is not. Recovery of a link that exists belongs
      // to the link.
      if (this.viewers.has(peerId)) return
      if (!peer.state.screen && !peer.state.camera && !peer.state.mic) return

      console.warn(`[rtc] ${peerId}: sem resposta ao join, pedindo de novo`)
      this.requestStream(peerId)
    }, JOIN_RETRY_MS)

    this.joinRetries.set(peerId, timer)
  }

  private cancelJoinRetry(peerId: string): void {
    const timer = this.joinRetries.get(peerId)
    if (timer === undefined) return
    window.clearTimeout(timer)
    this.joinRetries.delete(peerId)
  }

  private cancelRejoin(peerId: string): void {
    const timer = this.rejoinTimers.get(peerId)
    if (timer === undefined) return
    window.clearTimeout(timer)
    this.rejoinTimers.delete(peerId)
  }

  /**
   * Hand the mixer every audio stream this peer has, in one call.
   *
   * Screen audio and microphone arrive on separate slots and at separate
   * times, and the mixer rebuilds the peer's channel from scratch on each
   * call, so they have to be presented together or the later one silences the
   * earlier.
   */
  /**
   * Reconsider the uplink budget from measured round-trip time and loss.
   *
   * Reads the publisher links, because those are the ones spending our upload.
   */
  /**
   * Reconsider each viewer's bitrate from that viewer's own measurements.
   *
   * Per link, deliberately. The first version took the WORST round-trip time
   * across every viewer and handed one shared budget to all of them, which
   * means one friend on bad Wi-Fi quietly capped everybody else — and a room
   * where everyone has a good connection is then only as good as its unluckiest
   * member. That is not a network limitation, it is an averaging mistake.
   *
   * Two separate limits are at work and they should not be confused:
   *
   *   - What THIS viewer's path can carry, measured from their own round-trip
   *     time and loss. Theirs to earn and theirs to lose.
   *   - What OUR uplink can carry in total, which really is shared — a mesh
   *     sends one full copy per viewer. When the sum of what everyone earned
   *     exceeds it, every share is scaled down in proportion.
   *
   * So a weak viewer now drops to their own floor and the bandwidth they are
   * not using goes back to the pool for everyone else.
   */
  private governUpload(): void {
    const links = [...this.publishers.values()]
    if (links.length === 0) {
      this.budgets.clear()
      return
    }

    // A machine that cannot encode fast enough will not encode faster because
    // it was asked for more bits. Hold every share where it is.
    const cpuBound = links.some((link) => link.stats.limitation === 'cpu')

    for (const link of links) {
      const stats = link.stats
      const id = link.peerId
      const ceiling = stats.relayed ? BUDGET_MAX_RELAYED : BUDGET_MAX
      let budget = Math.min(this.budgets.get(id) ?? BUDGET_START, ceiling)

      // RTT arrives in RTCP and takes a few seconds. Silence is not good news.
      if (stats.rttMs > 0 && !cpuBound) {
        const strained = stats.rttMs > RTT_STRAINED_MS || stats.lossRatio > LOSS_STRAINED
        const healthy = stats.rttMs < RTT_HEALTHY_MS && stats.lossRatio < LOSS_HEALTHY

        if (strained) {
          this.streaks.set(id, 0)
          budget = Math.max(BUDGET_MIN, Math.round(budget * 0.6))
        } else if (healthy) {
          const streak = (this.streaks.get(id) ?? 0) + 1
          if (streak >= GOVERNOR_PATIENCE) {
            this.streaks.set(id, 0)
            budget = Math.min(ceiling, Math.round(budget * 1.25))
          } else {
            this.streaks.set(id, streak)
          }
        } else {
          this.streaks.set(id, 0)
        }
      }

      this.budgets.set(id, budget)
    }

    // Forget anyone who left, so their budget does not come back with them.
    for (const id of [...this.budgets.keys()]) {
      if (!this.publishers.has(id)) {
        this.budgets.delete(id)
        this.streaks.delete(id)
      }
    }

    this.spreadBudget()
  }

  /**
   * Apply each viewer's budget, scaled to fit the uplink we actually have.
   *
   * Only the total is shared. If everyone's earned bitrate fits under it,
   * everyone gets what they earned — which is the whole point: a room of good
   * connections should look like a room of good connections.
   */
  private spreadBudget(): void {
    const links = [...this.publishers.values()]
    if (links.length === 0) return

    const wanted = links.map((link) => this.budgets.get(link.peerId) ?? BUDGET_START)
    const total = wanted.reduce((sum, value) => sum + value, 0)
    const scale = total > UPLINK_TOTAL_MAX ? UPLINK_TOTAL_MAX / total : 1

    links.forEach((link, index) => {
      void link.setUploadBudget(Math.max(BUDGET_MIN, Math.round(wanted[index] * scale)))
    })
  }

  private attachAudio(peer: PeerView): void {
    const streams = AUDIO_SLOTS.flatMap((slot) => {
      const stream = peer.streams.get(slot)
      if (!stream) return []
      // The microphone is a voice and is always heard; the screen's audio is
      // part of a broadcast and is heard only when that broadcast has the
      // stage.
      return [{ stream, kind: slot === 'mic' ? ('voice' as const) : ('content' as const) }]
    })
    this.mixer.attach(peer.info.id, streams)
    peer.audible = this.mixer.isAudible(peer.info.id)

    // Re-state the whole rule after every rebuild.
    //
    // A channel is rebuilt whenever a track arrives, and each rebuild sets
    // its own gain from a set that is only read, never re-checked against
    // the others. Saying it again here means there is exactly one place
    // that decides who is audible, and it cannot be out of date — which is
    // how someone ended up hearing a broadcast they had not chosen.
    this.mixer.setContentFocus(this.listening)
  }

  /**
   * Ask a publisher for its stream, and keep asking.
   *
   * A `join` is one message and a `joinResponse` is another; either can be
   * lost, and the publisher can be mid-restart when it arrives. A single
   * unanswered request left the person staring at a room that said someone
   * was live while showing nothing — recoverable only by leaving and coming
   * back, which is not a thing anyone should have to work out.
   */
  /**
   * Start receiving someone's picture. Their voice was never gone.
   *
   * Touches neither the focus nor the sound. Both were in here once and
   * both were wrong: a friend going live while you were already watching
   * someone would re-evaluate the layout and move you off what you had
   * chosen — the stage changing under you because a THIRD party did
   * something. Where you are looking is yours; this only makes the picture
   * available.
   *
   * Sound has exactly two switches, both of them yours: opening a
   * broadcast, and the speaker.
   */
  watch(peerId: string): void {
    const peer = this.peers.get(peerId)
    if (!peer || peer.watching) return
    peer.watching = true
    peer.frozen = null
    // The tracks are already in their slots if the link is up; the publisher
    // simply stopped filling the video ones.
    peer.screen = peer.state.screen ? (peer.streams.get('screen') ?? null) : null
    peer.camera = peer.state.camera ? (peer.streams.get('camera') ?? null) : null
    this.signaling?.send({ t: 'watchVideo', to: peerId, video: true })
    this.attachAudio(peer)
    this.emit()
    // The link usually already exists, carrying their voice. Only a peer we
    // somehow never connected to needs one built now.
    if (!this.viewers.has(peerId)) this.requestStream(peerId)
  }

  /**
   * Stop receiving someone's broadcast, keeping the last frame.
   *
   * The link is genuinely torn down: in a mesh this hands bandwidth back to
   * the person broadcasting, which is the whole reason leaving a stream is
   * worth offering at all.
   */
  /** @deprecated Watching is no longer optional; only the sound is. */
  unwatch(peerId: string, poster: string | null = null): void {
    const peer = this.peers.get(peerId)
    if (!peer || !peer.watching) return

    // The still comes from the caller because the caller owns the <video>
    // that is actually rendering frames. A fresh element built here would
    // have nothing decoded in it yet and would draw black.
    peer.frozen = poster
    peer.watching = false
    // The connection stays up and so does their voice. The picture and the
    // sound of what they were showing both stop — that is the broadcast.
    //
    // The cached slot streams are NOT dropped, and that is the whole point.
    // They were, once, and it cost the audio permanently: the link stays
    // alive here on purpose, so when the publisher refills the slot it does
    // so with `replaceTrack`, which fires no `ontrack`. Anything thrown away
    // while the link lives is never handed over again. Leaving and rejoining
    // a broadcast brought the picture back and left it silent forever.
    //
    // Nothing needed throwing away in the first place: the publisher stops
    // sending, and the gain is already at zero.
    peer.screen = null
    peer.camera = null
    this.signaling?.send({ t: 'watchVideo', to: peerId, video: false })
    if (this.focused === peerId) this.focused = null
    if (this.listening === peerId) this.listenTo(null)
    this.emit()
  }

  private requestStream(peerId: string): void {
    this.cancelRejoin(peerId)
    this.scheduleJoinRetry(peerId)
    // State the intent with the request, so a publisher never spends upload
    // on a picture nobody opened.
    const peer = this.peers.get(peerId)
    this.signaling?.send({ t: 'watchVideo', to: peerId, video: peer?.watching ?? false })
    this.mixer.resume()
    this.signaling?.send({ t: 'join', to: peerId })
  }

  /**
   * Build a publisher link for one viewer and answer with `joinResponse`.
   *
   * Note that every link receives the SAME track objects. Do not clone — that
   * is what lets Chromium run one encoder for all viewers.
   */
  private async publishTo(peerId: string): Promise<void> {
    if (!this.isPublishing()) {
      this.send(peerId, 'out', {
        cmd: 'joinResponse',
        decision: false,
        reason: 'nada publicado'
      })
      return
    }

    // A join for someone we are already streaming to is a duplicate, not a
    // reason to start over. `join` is re-sent when a response goes missing,
    // and the re-send can arrive after the original finally lands — tearing
    // the connection down at that point stops a picture that was working and
    // builds a new one in its place. From the room that looks exactly like
    // the broadcaster quitting and starting again, which is what everyone
    // was reacting to.
    const current = this.publishers.get(peerId)
    if (current && (current.state === 'live' || current.state === 'connecting')) {
      console.warn(`[rtc] ${peerId}: join duplicado, mantendo o link que ja existe`)
      return
    }

    current?.close()
    const link = this.makeLink(peerId, 'publisher')
    this.publishers.set(peerId, link)
    await this.flushCandidates(peerId + ':in', link)

    // Everyone's share of the upload just shrank by one.
    this.spreadBudget()

    // Only this link stands between the newcomer and the picture. The other
    // links are brought in line afterwards, off the critical path, so nobody
    // waits on a connection that has nothing to do with them.
    await this.syncLink(link)
    const offer = await link.createOffer()
    this.send(peerId, 'out', { cmd: 'joinResponse', decision: true, offer })
    void this.syncTracks()
  }

  private isPublishing(): boolean {
    return this.local.screen !== null || this.local.camera !== null || this.local.mic !== null
  }

  /**
   * Point every viewer's slots at what we are currently publishing.
   *
   * Nothing is added, removed or renegotiated: the slots were created with
   * the connection and only ever have their contents swapped. That is why
   * toggling a camera no longer makes everyone's picture hitch — there is no
   * offer/answer to wait for.
   *
   * It also fixes a worse failure. Removing a video transceiver from a
   * BUNDLEd connection and renegotiating could take the remaining media down
   * with it, which is how a viewer lost the screen share when the
   * broadcaster merely turned their camera OFF.
   */
  private async syncTracks(): Promise<void> {
    // In parallel, and one failure at a time. This used to be a sequential
    // loop that every caller awaited, which meant a single wedged link — a
    // ghost left behind by someone who restarted, say — delayed or blocked
    // the work of every other link behind it. That is how a person could join
    // a room, see that someone was live, and never receive the offer.
    await Promise.allSettled(
      [...this.publishers.values()].map((link) => this.syncLink(link))
    )
  }

  /** Point one link's slots at what we are publishing. Never throws. */
  private async syncLink(link: PeerLink): Promise<void> {
    // Leaving a broadcast stops the broadcast — picture AND the sound of
    // whatever is being shown. What it must never stop is the MICROPHONE:
    // the game's audio is part of the thing you stepped away from, your
    // friend's voice is not, and gating them together would mean the only
    // way to stop watching someone was to stop hearing them.
    const watching = !this.videoMuted.has(link.peerId)
    const screen = watching ? (this.local.screen?.getVideoTracks()[0] ?? null) : null
    const screenAudio = watching ? (this.local.screen?.getAudioTracks()[0] ?? null) : null
    const camera = watching ? (this.local.camera?.getVideoTracks()[0] ?? null) : null
    const mic = this.local.mic?.getAudioTracks()[0] ?? null

    try {
      await link.setSlot('screen', screen, this.local.profile)
      await link.setSlot('camera', camera)
      await link.setSlot('screenAudio', screenAudio)
      await link.setSlot('mic', mic)
    } catch (error) {
      console.warn(`[rtc] ${link.peerId}: nao consegui sincronizar:`, error)
    }
  }

  private announce(): void {
    const state: PeerPublishState = {
      ...emptyPublishState(),
      screen: this.local.screen !== null,
      camera: this.local.camera !== null,
      mic: this.local.mic !== null,
      screenLabel: this.local.screenLabel ?? undefined,
      screenStreamId: this.local.screen?.id,
      cameraStreamId: this.local.camera?.id
    }
    this.signaling?.send({ t: 'publishState', state })
  }

  // --- local publishing ---------------------------------------------------

  async setScreen(stream: MediaStream | null, label: string | null): Promise<void> {
    // Your own broadcast gets the same cue as everyone else's: it is the
    // confirmation that you are actually live.
    if (!this.local.screen && stream) soundLiveStart()
    if (this.local.screen && !stream) soundLiveEnd()

    const previous = this.local.screen
    this.local.screen = stream
    this.local.screenLabel = label

    if (stream) {
      // The OS "stop sharing" affordance ends the track behind our back.
      //
      // The guard is the important part. Changing source installs a new
      // stream while the old one is still alive, and the old track ends
      // moments later — asynchronously, and with its listener still
      // attached. Unguarded, that listener tore down the share that had just
      // replaced it: the source change appeared to do nothing, and the only
      // way back was to leave and rejoin.
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (this.local.screen !== stream) return
        void this.setScreen(null, null)
      })
    }

    this.announce()
    this.emit()
    await this.syncTracks()

    // Only now. Stopping the old tracks first left every sender holding a
    // dead track for the length of the swap, which viewers saw as the
    // picture freezing before it came back — when it came back.
    previous?.getTracks().forEach((t) => t.stop())
  }

  /**
   * Point the camera or microphone at a different device, live.
   *
   * Every viewer's sender has its track swapped in place, so nobody sees a
   * reconnect — the picture simply becomes the other camera. Falls back to a
   * full republish only if a sender refuses the swap.
   */
  /**
   * Point the camera or microphone at a different device, live.
   *
   * With fixed slots this is the ordinary path rather than a special case:
   * the new track goes into the same slot, no renegotiation, no interruption.
   */
  async swapDevice(kind: 'camera' | 'mic', stream: MediaStream | null): Promise<void> {
    const previous = kind === 'camera' ? this.local.camera : this.local.mic
    previous?.getTracks().forEach((t) => t.stop())
    if (kind === 'camera') this.local.camera = stream
    else this.local.mic = stream
    this.announce()
    this.emit()
    await this.syncTracks()
  }

  async setCamera(stream: MediaStream | null): Promise<void> {
    this.local.camera?.getTracks().forEach((t) => t.stop())
    this.local.camera = stream
    this.announce()
    this.emit()
    await this.syncTracks()
  }

  async setMic(stream: MediaStream | null): Promise<void> {
    this.local.mic?.getTracks().forEach((t) => t.stop())
    this.local.mic = stream
    this.announce()
    this.emit()
    await this.syncTracks()
  }

  async setScreenProfile(profile: ScreenProfileName): Promise<void> {
    this.local.profile = profile
    const track = this.local.screen?.getVideoTracks()[0]

    if (track) {
      const wanted = SCREEN_PROFILES[profile]
      // Apply to the local track first. With nobody watching there are no
      // senders to configure, but the hint still has to be right so the very
      // first viewer gets the profile you picked.
      setContentHint(track, wanted.contentHint)

      // Change what the SOURCE produces too, not only what the encoder is
      // allowed to do with it. Capture rate was fixed when the share opened,
      // so picking "Fluido" mid-broadcast asked for 60 fps from a source
      // still handing over 30 — a setting that could not take effect no
      // matter how long anyone waited for it.
      try {
        await track.applyConstraints({
          frameRate: { ideal: wanted.maxFramerate, max: wanted.maxFramerate }
        })
      } catch (error) {
        // Some capture sources refuse to be reconfigured; the encoder-side
        // limits below still apply.
        console.warn('[rtc] fonte recusou a nova taxa de quadros:', error)
      }

      for (const link of this.publishers.values()) await link.setScreenProfile(profile)

      const settings = track.getSettings()
      console.log(
        `[rtc] perfil ${profile}: captura ${settings.width}x${settings.height} ` +
          `@ ${Math.round(settings.frameRate ?? 0)}fps, ` +
          `escala 1/${wanted.scaleResolutionDownBy ?? 1}`
      )
    }
    this.emit()
  }

  // --- viewing ------------------------------------------------------------

  /**
   * Drop to the cheapest profile because at least one viewer is on a relay.
   *
   * Only ever downgrades: if someone already chose `thrifty`, or picked a
   * profile deliberately after this fired, we leave their choice alone.
   */
  /**
   * Go into a broadcast, or step back out to the grid.
   *
   * Going IN turns its sound on: opening someone's broadcast is a request
   * to watch it, and a picture you opened on purpose arriving silent is
   * just one more thing to click.
   *
   * Stepping back out does NOT turn it off. Escape is about the layout —
   * you wanted the others in view again, not to stop listening to this
   * one. Stopping is `leaveBroadcast`: a different button saying a
   * different thing.
   */
  focus(peerId: string | null): void {
    this.focused = peerId
    if (peerId !== null) this.listenTo(peerId)
    else this.emit()
  }

  /**
   * Is anything at all on the stage right now, ours included?
   *
   * Only used to decide whether a new broadcast may take the stage by
   * itself. A quiet room has nothing to interrupt; any other room does.
   */
  private anythingLive(exclude?: string): boolean {
    if (this.local.screen !== null || this.local.camera !== null) return true
    for (const peer of this.peers.values()) {
      if (peer.info.id === exclude) continue
      if (peer.state.screen || peer.state.camera) return true
    }
    return false
  }

  /** Step out of a broadcast: back to the grid, and silence it. */
  leaveBroadcast(peerId: string): void {
    if (this.focused === peerId) this.focused = null
    if (this.listening === peerId) this.listenTo(null)
    else this.emit()
  }

  /**
   * Choose whose broadcast you can hear. At most one, `null` for none.
   *
   * Separate from focus because in a grid you watch several and listen to
   * one, and those are different choices. Voices are untouched either way.
   */
  listenTo(peerId: string | null): void {
    this.listening = peerId
    this.mixer.setContentFocus(peerId)
    this.emit()
  }

  setPeerAudio(peerId: string, patch: Partial<PeerAudio>): void {
    // The mixer now always accepts the setting, even for a peer who is not
    // sending audio yet, and replays it when they do. Gating the state update
    // on the mixer having a live channel is what froze the slider whenever
    // someone shared a silent screen.
    const applied = this.mixer.setPeerAudio(peerId, patch)
    const peer = this.peers.get(peerId)
    if (peer) {
      peer.audio = applied
      this.emit()
    }
  }

  get signalingRtt(): number {
    return this.signaling?.rtt ?? 0
  }
}
