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
import { Signaling, type SignalingStatus } from './signaling'

/**
 * How long a viewer link may stay down before we rebuild it from scratch.
 *
 * Long enough for the publisher's ICE restarts to land first — rebuilding is
 * a visible interruption, restarting is not.
 */
const REJOIN_AFTER_MS = 20_000

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
}

export interface LocalPublish {
  screen: MediaStream | null
  camera: MediaStream | null
  mic: MediaStream | null
  screenLabel: string | null
  profile: ScreenProfileName
}

export interface SessionSnapshot {
  status: SignalingStatus
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
  private readonly clientId = crypto.randomUUID()
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
    profile: 'smooth'
  }

  /** Set once per session, so a manual profile change is not fought over. */
  private relayThrottled = false

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
      local: { ...this.local },
      focused: this.focused,
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
    this.emit()
  }

  disconnect(): void {
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

  private dropLinks(peerId: string): void {
    this.cancelRejoin(peerId)
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
        this.emit()
        // Subscribe to everyone already publishing.
        for (const peer of message.peers) {
          if (peer.state.screen || peer.state.camera || peer.state.mic) {
            this.requestStream(peer.id)
          }
        }
        break
      }

      case 'peerJoined': {
        this.peers.set(message.peer.id, this.blankPeer(message.peer, message.state))
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

        if (!wasPublishing && nowPublishing) this.requestStream(message.id)
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
          if (this.focused === message.id) this.focused = null
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
        if (message.state.screen && this.focused === null) this.focused = message.id
        this.emit()
        break
      }

      // Someone wants our stream. Admission + offer in one reply, the way
      // TeamSpeak's `joinResponse` does it — saves a round trip.
      case 'join': {
        await this.publishTo(message.from)
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
      streams: new Map()
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
          this.mixer.attach(peerId, stream)
          peer.audible = true
        }

        if (this.focused === null && slot === 'screen') this.focused = peerId
        this.emit()
      },
      onState: (state) => {
        const peer = this.peers.get(peerId)
        if (!peer || peer.link === state) return
        peer.link = state
        if (role === 'viewer') {
          if (state === 'interrupted') this.scheduleRejoin(peerId)
          else this.cancelRejoin(peerId)
        }
        this.emit()
      },
      onStats: (stats) => {
        const peer = this.peers.get(peerId)
        if (!peer) return
        const wasRelayed = peer.stats.relayed
        peer.stats = stats
        // Going through a relay is the only path that costs money, so it is
        // also the only path worth throttling. Dropping to the thrifty
        // profile cuts a relayed stream from roughly 5 Mbit/s to 2.5 —
        // halving both the bill and the odds of saturating someone's upload.
        if (!wasRelayed && stats.relayed && role === 'publisher') {
          console.warn(`[rtc] ${peerId} is relayed; dropping to thrifty`)
          void this.throttleRelayed()
        }
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

  private cancelRejoin(peerId: string): void {
    const timer = this.rejoinTimers.get(peerId)
    if (timer === undefined) return
    window.clearTimeout(timer)
    this.rejoinTimers.delete(peerId)
  }

  private requestStream(peerId: string): void {
    this.cancelRejoin(peerId)
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

    this.publishers.get(peerId)?.close()
    const link = this.makeLink(peerId, 'publisher')
    this.publishers.set(peerId, link)
    await this.flushCandidates(peerId + ':in', link)

    // Everyone's share of the upload just shrank by one.
    for (const other of this.publishers.values()) other.setViewerCount(this.publishers.size)

    await this.syncTracks()
    const offer = await link.createOffer()
    this.send(peerId, 'out', { cmd: 'joinResponse', decision: true, offer })
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
    const screen = this.local.screen?.getVideoTracks()[0] ?? null
    const screenAudio = this.local.screen?.getAudioTracks()[0] ?? null
    const camera = this.local.camera?.getVideoTracks()[0] ?? null
    const mic = this.local.mic?.getAudioTracks()[0] ?? null

    for (const link of this.publishers.values()) {
      link.setViewerCount(this.publishers.size)
      await link.setSlot('screen', screen, this.local.profile)
      await link.setSlot('camera', camera)
      await link.setSlot('screenAudio', screenAudio)
      await link.setSlot('mic', mic)
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
    this.local.screen?.getTracks().forEach((t) => t.stop())
    this.local.screen = stream
    this.local.screenLabel = label
    if (stream) {
      // The OS "stop sharing" affordance ends the track behind our back.
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        void this.setScreen(null, null)
      })
    }
    this.announce()
    this.emit()
    await this.syncTracks()
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
      // Apply to the local track first. With nobody watching there are no
      // senders to configure, but the hint still has to be right so the very
      // first viewer gets the profile you picked.
      setContentHint(track, SCREEN_PROFILES[profile].contentHint)

      for (const link of this.publishers.values()) await link.setScreenProfile(profile)
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
  private async throttleRelayed(): Promise<void> {
    if (this.local.profile === 'thrifty' || this.relayThrottled) return
    this.relayThrottled = true
    await this.setScreenProfile('thrifty')
  }

  focus(peerId: string | null): void {
    this.focused = peerId
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
