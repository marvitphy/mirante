import type { RTCIceServerConfig, SignalPayload } from '../../../shared/protocol'
import {
  applyAudioTuning,
  applyProfile,
  CAMERA_PROFILE,
  MEDIA_OPUS,
  preferCodecs,
  setContentHint,
  SCREEN_PROFILES,
  type ScreenProfileName
} from './sdp'

/**
 * One peer, one `RTCPeerConnection`.
 *
 * This is the mesh unit. `MeshSession` owns a map of these — exactly the shape
 * the TeamSpeak teardown showed, where `SessionOutbound::ResolveJoinRequest`
 * fires once per viewer and each viewer gets its own ICE credentials and DTLS
 * fingerprint.
 *
 * The one thing that must NOT happen here: cloning tracks per peer. The same
 * `MediaStreamTrack` instance is added to every connection so Chromium can run
 * a single encoder across all of them. That is the browser equivalent of
 * TeamSpeak's `TeamSpeakSharedVideoEncoderFactory` / `SFUEncoderBroadcaster`,
 * and it is the difference between O(1) and O(N) CPU in a mesh.
 */

export type LinkRole = 'publisher' | 'viewer'
export type LinkState = 'new' | 'connecting' | 'live' | 'interrupted' | 'closed'

export interface LinkStats {
  /** Round-trip time on the selected candidate pair, milliseconds. */
  rttMs: number
  /** Inbound or outbound bitrate depending on role, bits per second. */
  bitrate: number
  framerate: number
  width: number
  height: number
  packetsLost: number
  /** 0..1 over the last sample window. */
  lossRatio: number
  jitterMs: number
  codec: string
  /** 'host' when truly peer-to-peer, 'srflx' through NAT, 'relay' via TURN. */
  candidateType: string
  /** True when media is going through a TURN relay rather than direct. */
  relayed: boolean
}

export const EMPTY_STATS: LinkStats = {
  rttMs: 0,
  bitrate: 0,
  framerate: 0,
  width: 0,
  height: 0,
  packetsLost: 0,
  lossRatio: 0,
  jitterMs: 0,
  codec: '',
  candidateType: '',
  relayed: false
}

export interface PeerLinkOptions {
  peerId: string
  role: LinkRole
  iceServers: RTCIceServerConfig[]
  send: (payload: SignalPayload) => void
  /**
   * A track arrived, tagged with the slot it came in on.
   *
   * Slots are created in a fixed order, so the transceiver's `mid` identifies
   * the role without anything being announced. That also replaces reading
   * `event.streams[0]`, which is empty once senders come from
   * `addTransceiver` rather than `addTrack`.
   */
  onTrack: (slot: SlotName, track: MediaStreamTrack) => void
  onState: (state: LinkState) => void
  onStats: (stats: LinkStats) => void
}

/**
 * The media a link can carry, in a fixed order.
 *
 * Screen audio is separate from the microphone: they have different sources,
 * different tuning, and either can be absent.
 */
export type SlotName = 'screen' | 'camera' | 'screenAudio' | 'mic'

const SLOTS: Array<{ name: SlotName; kind: 'video' | 'audio' }> = [
  { name: 'screen', kind: 'video' },
  { name: 'camera', kind: 'video' },
  { name: 'screenAudio', kind: 'audio' },
  { name: 'mic', kind: 'audio' }
]

const STATS_INTERVAL_MS = 1_000
/** How long a dip must persist before the user is told about it. */
const INTERRUPT_GRACE_MS = 2_000
/** Agreeing samples before the relay badge flips, in either direction. */
const RELAY_CONFIRMATIONS = 3

interface StatsCursor {
  bytes: number
  packets: number
  lost: number
  frames: number
  at: number
}

export class PeerLink {
  readonly peerId: string
  readonly role: LinkRole

  private readonly pc: RTCPeerConnection
  private readonly options: PeerLinkOptions
  private readonly slots = new Map<SlotName, RTCRtpTransceiver>()
  /** How many viewers share this publisher's upload, for budgeting. */
  private shareOfUpload = 1
  /** Candidates that arrive before the remote description is set. */
  private readonly pendingCandidates: RTCIceCandidateInit[] = []
  private statsTimer: number | null = null
  /**
   * Pending "interrupted" announcement.
   *
   * ICE dips into `disconnected` on any brief hiccup and usually recovers in
   * well under a second. Forwarding that straight to the UI makes
   * "Reconnecting" strobe at people while the picture never actually stops.
   */
  private interruptTimer: number | null = null
  /** Consecutive samples agreeing the path is relayed. */
  private relaySamples = 0
  /**
   * Last round-trip time we actually measured.
   *
   * Not every `getStats` sample carries one — RTT comes from RTCP reports,
   * which arrive on their own schedule. Treating a sample without one as
   * zero made the readout blink between a real number and "—", and since
   * the text changed width it shoved the volume slider sideways each time.
   */
  private lastRtt = 0
  private cursor: StatsCursor | null = null
  private makingOffer = false
  private closed = false

  constructor(options: PeerLinkOptions) {
    this.options = options
    this.peerId = options.peerId
    this.role = options.role

    this.pc = new RTCPeerConnection({
      iceServers: options.iceServers as RTCIceServer[],
      // 'all' keeps host candidates in play so a LAN pair stays on the LAN.
      // TeamSpeak does the same, and it is why two friends in one house get
      // sub-millisecond paths instead of a round trip through a relay.
      iceTransportPolicy: 'all',
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require'
    })

    this.pc.addEventListener('icecandidate', (event) => {
      if (event.candidate) {
        // Trickle: send each candidate the moment it is gathered rather than
        // waiting for gathering to finish.
        options.send({ cmd: 'iceCandidate', candidate: event.candidate.toJSON() })
      }
    })

    this.pc.addEventListener('track', (event) => {
      const index = Number(event.transceiver.mid)
      const slot = SLOTS[index]?.name
      if (slot) options.onTrack(slot, event.track)
    })

    this.pc.addEventListener('connectionstatechange', () => this.reportState())
    this.pc.addEventListener('iceconnectionstatechange', () => {
      // A failed ICE connection is recoverable without a full teardown — this
      // is the path TeamSpeak's `reconnectOffer` verb and `StreamBase::Reconnect`
      // symbol exist to serve.
      if (this.pc.iceConnectionState === 'failed' && this.role === 'publisher') {
        void this.restartIce()
      }
      this.reportState()
    })

    this.startStats()
  }

  private clearInterrupt(): void {
    if (this.interruptTimer !== null) {
      window.clearTimeout(this.interruptTimer)
      this.interruptTimer = null
    }
  }

  private reportState(): void {
    if (this.closed) return
    switch (this.pc.connectionState) {
      case 'connected':
        this.clearInterrupt()
        this.options.onState('live')
        break

      case 'disconnected':
        // Hold the bad news. Most of these recover before anyone could have
        // read the message, and a notice that flickers is worse than none.
        if (this.interruptTimer === null) {
          this.interruptTimer = window.setTimeout(() => {
            this.interruptTimer = null
            if (!this.closed && this.pc.connectionState === 'disconnected') {
              this.options.onState('interrupted')
            }
          }, INTERRUPT_GRACE_MS)
        }
        break

      case 'failed':
        // Failed does not recover on its own; say so immediately.
        this.clearInterrupt()
        this.options.onState('interrupted')
        break

      case 'closed':
        this.clearInterrupt()
        this.options.onState('closed')
        break

      default:
        this.options.onState('connecting')
    }
  }

  // --- publishing ---------------------------------------------------------

  /**
   * Fixed slots, created once, never removed.
   *
   * Adding and removing transceivers as people toggle things looks tidy and
   * is a trap: removing a video transceiver from a BUNDLEd connection and
   * renegotiating can take the remaining media down with it. That is what
   * made a viewer lose the screen when the broadcaster merely turned their
   * camera OFF.
   *
   * So every link gets the same four senders from the start, and turning
   * something on, off, or swapping its source is `replaceTrack` — which
   * needs no renegotiation at all and therefore cannot break anything.
   */
  private ensureSlots(): void {
    if (this.slots.size > 0) return
    for (const slot of SLOTS) {
      const transceiver = this.pc.addTransceiver(slot.kind, { direction: 'sendonly' })
      this.slots.set(slot.name, transceiver)
      if (slot.kind === 'video') {
        preferCodecs(transceiver, slot.name === 'camera' ? 'camera' : 'screen')
      }
    }
  }

  /** Put a track in a slot, or clear it. Returns true if the slot changed. */
  async setSlot(
    name: SlotName,
    track: MediaStreamTrack | null,
    screenProfile: ScreenProfileName = 'smooth'
  ): Promise<boolean> {
    this.ensureSlots()
    const transceiver = this.slots.get(name)
    if (!transceiver) return false

    const sender = transceiver.sender
    if (sender.track === track) return false

    if (track && name !== 'mic') {
      setContentHint(
        track,
        name === 'screen' ? SCREEN_PROFILES[screenProfile].contentHint : 'motion'
      )
    }

    try {
      await sender.replaceTrack(track)
    } catch (error) {
      console.warn(`[rtc] could not set ${name}:`, error)
      return false
    }

    if (track) {
      if (name === 'screen') await this.applyShared(sender, SCREEN_PROFILES[screenProfile])
      else if (name === 'camera') await this.applyShared(sender, CAMERA_PROFILE)
    }
    return true
  }

  /**
   * Split the upload budget across viewers.
   *
   * In a mesh the publisher sends a separate copy to every viewer, so the
   * profile's ceiling is a per-viewer figure that must be divided or three
   * friends will ask for three times the bandwidth one person has.
   */
  setViewerCount(count: number): void {
    this.shareOfUpload = Math.max(1, count)
  }

  private async applyShared(
    sender: RTCRtpSender,
    profile: (typeof SCREEN_PROFILES)[ScreenProfileName] | typeof CAMERA_PROFILE
  ): Promise<void> {
    // Never below 400 kbit/s: past that the picture stops being useful and
    // you may as well not send it.
    const budget = Math.max(400_000, Math.round(profile.maxBitrate / this.shareOfUpload))
    await applyProfile(sender, { ...profile, maxBitrate: budget })
  }

  /** Re-apply a quality profile to the live screen sender without renegotiating. */
  async setScreenProfile(profile: ScreenProfileName): Promise<void> {
    const sender = this.slots.get('screen')?.sender
    if (sender?.track) await this.applyShared(sender, SCREEN_PROFILES[profile])
  }

  /**
   * Offer again over the SAME connection.
   *
   * Only needed when the slot layout itself changes, which now happens once
   * per link. Everything after that is replaceTrack.
   */
  async renegotiate(): Promise<void> {
    if (this.closed || this.makingOffer) return
    if (this.pc.signalingState !== 'stable') return
    this.makingOffer = true
    try {
      const offer = await this.pc.createOffer()
      const tuned = applyAudioTuning(offer, MEDIA_OPUS)
      await this.pc.setLocalDescription(tuned)
      this.options.send({ cmd: 'offer', offer: tuned })
    } catch (error) {
      console.warn('[rtc] renegotiation failed:', error)
    } finally {
      this.makingOffer = false
    }
  }

  // --- negotiation --------------------------------------------------------

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    this.makingOffer = true
    try {
      const offer = await this.pc.createOffer()
      const tuned = applyAudioTuning(offer, MEDIA_OPUS)
      await this.pc.setLocalDescription(tuned)
      return tuned
    } finally {
      this.makingOffer = false
    }
  }

  async acceptOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    await this.pc.setRemoteDescription(offer)
    await this.drainCandidates()
    const answer = await this.pc.createAnswer()
    const tuned = applyAudioTuning(answer, MEDIA_OPUS)
    await this.pc.setLocalDescription(tuned)
    return tuned
  }

  async acceptAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    // Ignore a stale answer that raced an ICE restart.
    if (this.pc.signalingState !== 'have-local-offer') return
    await this.pc.setRemoteDescription(answer)
    await this.drainCandidates()
  }

  async addCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.pc.remoteDescription) {
      this.pendingCandidates.push(candidate)
      return
    }
    try {
      await this.pc.addIceCandidate(candidate)
    } catch (error) {
      console.warn('[rtc] rejected candidate:', error)
    }
  }

  private async drainCandidates(): Promise<void> {
    while (this.pendingCandidates.length > 0) {
      const candidate = this.pendingCandidates.shift()
      if (!candidate) break
      try {
        await this.pc.addIceCandidate(candidate)
      } catch {
        // Candidate no longer applies to the current description.
      }
    }
  }

  /** Resume after a network blip instead of tearing the session down. */
  async restartIce(): Promise<void> {
    if (this.closed || this.makingOffer) return
    this.makingOffer = true
    try {
      const offer = await this.pc.createOffer({ iceRestart: true })
      const tuned = applyAudioTuning(offer, MEDIA_OPUS)
      await this.pc.setLocalDescription(tuned)
      this.options.send({ cmd: 'reconnectOffer', offer: tuned })
    } catch (error) {
      console.warn('[rtc] ICE restart failed:', error)
    } finally {
      this.makingOffer = false
    }
  }

  // --- telemetry ----------------------------------------------------------

  private startStats(): void {
    this.statsTimer = window.setInterval(() => {
      void this.sampleStats()
    }, STATS_INTERVAL_MS)
  }

  private async sampleStats(): Promise<void> {
    if (this.closed) return
    let report: RTCStatsReport
    try {
      report = await this.pc.getStats()
    } catch {
      return
    }

    const next: LinkStats = { ...EMPTY_STATS }
    const now = performance.now()
    let bytes = 0
    let packets = 0
    let lost = 0
    let frames = 0
    const codecIds = new Set<string>()

    // Pass 1: media counters, and the id of the pair actually carrying them.
    let selectedPairId: string | null = null
    report.forEach((entry) => {
      if (entry.type === 'outbound-rtp' && entry.kind === 'video' && !entry.isRemote) {
        bytes += (entry.bytesSent as number) ?? 0
        packets += (entry.packetsSent as number) ?? 0
        frames += (entry.framesEncoded as number) ?? 0
        next.width = (entry.frameWidth as number) ?? next.width
        next.height = (entry.frameHeight as number) ?? next.height
        if (entry.codecId) codecIds.add(entry.codecId as string)
      }
      if (entry.type === 'inbound-rtp' && entry.kind === 'video') {
        bytes += (entry.bytesReceived as number) ?? 0
        packets += (entry.packetsReceived as number) ?? 0
        lost += (entry.packetsLost as number) ?? 0
        frames += (entry.framesDecoded as number) ?? 0
        next.jitterMs = Math.round(((entry.jitter as number) ?? 0) * 1000)
        next.width = (entry.frameWidth as number) ?? next.width
        next.height = (entry.frameHeight as number) ?? next.height
        if (entry.codecId) codecIds.add(entry.codecId as string)
      }
      if (entry.type === 'remote-inbound-rtp') {
        lost += (entry.packetsLost as number) ?? 0
      }
      // `transport.selectedCandidatePairId` is the authoritative answer to
      // "which pair is carrying media". Scanning every gathered candidate
      // instead reports `relay` whenever TURN is merely CONFIGURED, because a
      // relay candidate is always gathered — which is how a perfectly direct
      // connection ended up labelled as relayed, and how the automatic
      // throttle fired on sessions that never needed it.
      if (entry.type === 'transport' && entry.selectedCandidatePairId) {
        selectedPairId = entry.selectedCandidatePairId as string
      }
    })

    // Pass 2: resolve the selected pair, its RTT, and its local candidate.
    let localCandidateId: string | null = null
    report.forEach((entry) => {
      if (entry.type !== 'candidate-pair') return
      const chosen =
        selectedPairId !== null ? entry.id === selectedPairId : entry.nominated === true
      if (!chosen || entry.state !== 'succeeded') return
      if (typeof entry.currentRoundTripTime === 'number') {
        next.rttMs = Math.round(entry.currentRoundTripTime * 1000)
      }
      localCandidateId = (entry.localCandidateId as string) ?? null
    })

    // Pass 3: the codec, and the type of the candidate actually in use.
    report.forEach((entry) => {
      if (entry.type === 'codec' && codecIds.has(entry.id as string)) {
        const mime = (entry.mimeType as string) ?? ''
        next.codec = mime.replace(/^video\//, '').replace(/^audio\//, '')
      }
      if (entry.type === 'local-candidate' && entry.id === localCandidateId) {
        next.candidateType = (entry.candidateType as string) ?? ''
      }
    })

    // Same reasoning as the interrupt grace: the selected pair can change
    // during ICE, and a badge that alternates between DIRECT and RELAYED
    // every second teaches the viewer to ignore it.
    const looksRelayed = next.candidateType === 'relay'
    this.relaySamples = looksRelayed
      ? Math.min(RELAY_CONFIRMATIONS, this.relaySamples + 1)
      : Math.max(0, this.relaySamples - 1)
    next.relayed = this.relaySamples >= RELAY_CONFIRMATIONS
    next.packetsLost = lost

    if (this.cursor) {
      const seconds = (now - this.cursor.at) / 1000
      if (seconds > 0) {
        next.bitrate = Math.max(0, Math.round(((bytes - this.cursor.bytes) * 8) / seconds))
        next.framerate = Math.max(0, Math.round((frames - this.cursor.frames) / seconds))
        const deltaPackets = packets - this.cursor.packets
        const deltaLost = lost - this.cursor.lost
        next.lossRatio =
          deltaPackets + deltaLost > 0 ? Math.max(0, deltaLost / (deltaPackets + deltaLost)) : 0
      }
    }

    // Carry the previous measurement rather than reporting a gap.
    if (next.rttMs > 0) this.lastRtt = next.rttMs
    else next.rttMs = this.lastRtt

    this.cursor = { bytes, packets, lost, frames, at: now }
    this.options.onStats(next)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.statsTimer !== null) window.clearInterval(this.statsTimer)
    this.clearInterrupt()
    this.slots.clear()
    this.pc.close()
    this.options.onState('closed')
  }
}
