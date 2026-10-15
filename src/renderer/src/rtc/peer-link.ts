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
  /**
   * Why the encoder is holding back, straight from `qualityLimitationReason`.
   *
   * This is the one number that settles an argument the rest of the telemetry
   * cannot. A soft picture looks identical whether the uplink is full or the
   * encoder cannot keep up, and the fixes are opposites: more bitrate helps
   * the first and does nothing at all for the second. Re-streaming a 1080p60
   * YouTube live is exactly where that distinction stops being academic.
   *
   * Only meaningful on a publisher link; a viewer reports 'none'.
   */
  limitation: 'none' | 'cpu' | 'bandwidth' | 'other'
}

export const EMPTY_STATS: LinkStats = {
  limitation: 'none',
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
/**
 * How long a dip must persist before the user is told about it.
 *
 * ICE declares `disconnected` after a couple of missed consent checks, which
 * a perfectly ordinary Wi-Fi hiccup produces several times an hour. At two
 * seconds the banner was firing on dips that had already healed — "Reconectando"
 * appearing out of nowhere over a picture that never stopped. Six seconds is
 * past the noise and still well short of the ~15s Chromium takes to give up.
 */
const INTERRUPT_GRACE_MS = 6_000

/**
 * Retry schedule for ICE restarts, in milliseconds.
 *
 * `iceconnectionstatechange` fires once per transition, so a restart triggered
 * by `failed` got exactly one attempt: if that offer was lost, or the answer
 * never came, the link stayed dead and the banner stayed up forever. Retrying
 * on a timer with backoff is what turns "Reconectando" into an actual
 * reconnection. The last value repeats for as long as the link is down.
 */
const RECOVERY_BACKOFF_MS = [4_000, 8_000, 15_000, 30_000]

/** Below this a moving picture stops being worth the bandwidth it costs. */
const MIN_BUDGET = 500_000
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
  /**
   * Ceiling for this one link, in bits per second, set by the governor.
   *
   * Null until the governor has spoken, in which case the profile's own
   * ceiling applies.
   */
  private uploadBudget: number | null = null
  /** The profile currently applied to the screen sender, for re-application. */
  private screenProfile: (typeof SCREEN_PROFILES)[ScreenProfileName] | null = null
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
  /** Scheduled ICE restart while the path is down. */
  private recoveryTimer: number | null = null
  private recoveryAttempt = 0
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
  /** The most recent telemetry sample, for anyone who needs it on demand. */
  private latest: LinkStats = EMPTY_STATS
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
        this.scheduleRecovery()
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

  private clearRecovery(): void {
    if (this.recoveryTimer !== null) {
      window.clearTimeout(this.recoveryTimer)
      this.recoveryTimer = null
    }
    this.recoveryAttempt = 0
  }

  /**
   * Keep trying to rebuild the path until it comes back or the link closes.
   *
   * Only the publisher does this: an ICE restart is an offer, and having both
   * ends offer at once is glare. The viewer's recovery is the restart its
   * publisher performs.
   */
  private scheduleRecovery(): void {
    if (this.closed || this.role !== 'publisher' || this.recoveryTimer !== null) return

    const index = Math.min(this.recoveryAttempt, RECOVERY_BACKOFF_MS.length - 1)
    const delay = RECOVERY_BACKOFF_MS[index]
    this.recoveryAttempt++

    this.recoveryTimer = window.setTimeout(() => {
      this.recoveryTimer = null
      if (this.closed) return
      if (this.pc.connectionState === 'connected') return

      console.warn(`[rtc] ${this.peerId}: tentativa ${this.recoveryAttempt} de reconexao`)
      void this.restartIce()
      this.scheduleRecovery()
    }, delay)
  }

  private reportState(): void {
    if (this.closed) return
    switch (this.pc.connectionState) {
      case 'connected':
        this.clearInterrupt()
        this.clearRecovery()
        this.options.onState('live')
        break

      case 'disconnected':
        // Hold the bad news. Most of these recover before anyone could have
        // read the message, and a notice that flickers is worse than none.
        // Repair starts straight away regardless — the grace period is about
        // what to SAY, not about what to do.
        this.scheduleRecovery()
        if (this.interruptTimer === null) {
          this.interruptTimer = window.setTimeout(() => {
            this.interruptTimer = null
            if (!this.closed && this.pc.connectionState !== 'connected') {
              this.options.onState('interrupted')
            }
          }, INTERRUPT_GRACE_MS)
        }
        break

      case 'failed':
        // Failed does not heal by itself, so this one is immediate — and it
        // keeps retrying rather than restarting once and hoping.
        this.clearInterrupt()
        this.options.onState('interrupted')
        this.scheduleRecovery()
        break

      case 'closed':
        this.clearInterrupt()
        this.clearRecovery()
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
      if (name === 'screen') {
        this.screenProfile = SCREEN_PROFILES[screenProfile]
        await this.applyShared(sender, this.screenProfile)
      } else if (name === 'camera') {
        await this.applyShared(sender, CAMERA_PROFILE)
      }
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
  /** Most recent telemetry for this link. */
  get stats(): LinkStats {
    return this.latest
  }

  /**
   * Set this link's share of the uplink, in bits per second.
   *
   * Replaces dividing the profile ceiling by the viewer count, which was a
   * guess in both directions at once: too much for someone on a thin
   * connection, and permanently too little for someone on fibre, since it
   * could only ever go down. The governor measures instead.
   */
  async setUploadBudget(bitsPerSecond: number): Promise<void> {
    const next = Math.max(MIN_BUDGET, Math.round(bitsPerSecond))
    if (this.uploadBudget === next) return
    this.uploadBudget = next

    const sender = this.slots.get('screen')?.sender
    if (sender?.track && this.screenProfile) await this.applyShared(sender, this.screenProfile)
  }

  private async applyShared(
    sender: RTCRtpSender,
    profile: (typeof SCREEN_PROFILES)[ScreenProfileName] | typeof CAMERA_PROFILE
  ): Promise<void> {
    // The profile is the ceiling; the governor can only ask for less.
    const budget = Math.min(profile.maxBitrate, this.uploadBudget ?? profile.maxBitrate)
    await applyProfile(sender, { ...profile, maxBitrate: Math.max(MIN_BUDGET, budget) })
  }

  /** Re-apply a quality profile to the live screen sender without renegotiating. */
  async setScreenProfile(profile: ScreenProfileName): Promise<void> {
    this.screenProfile = SCREEN_PROFILES[profile]
    const sender = this.slots.get('screen')?.sender
    if (sender?.track) await this.applyShared(sender, this.screenProfile)
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

        const reason = entry.qualityLimitationReason as string | undefined
        if (reason === 'cpu' || reason === 'bandwidth' || reason === 'other') {
          next.limitation = reason
        }
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
    this.latest = next
    this.options.onStats(next)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.statsTimer !== null) window.clearInterval(this.statsTimer)
    this.clearInterrupt()
    this.clearRecovery()
    this.slots.clear()
    this.pc.close()
    this.options.onState('closed')
  }
}
