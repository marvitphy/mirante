/**
 * Per-peer audio mixer.
 *
 * Every remote stream is routed through its own GainNode before reaching the
 * speakers. Three things fall out of that for free:
 *
 *   1. Independent volume per person — turn the loud friend down without
 *      touching the game audio.
 *   2. Local mute that costs no bandwidth argument with the sender.
 *   3. A live level meter per peer, which is what makes the rail feel alive
 *      rather than being a row of static avatars.
 *
 * `<audio>` elements alone would give you (1) crudely and none of (3).
 */

export interface PeerAudio {
  /** 0..2. Above 1 is a boost, which quiet friends genuinely need. */
  volume: number
  muted: boolean
}

/**
 * Where a person starts, before you have an opinion about them.
 *
 * A quarter, not full. A broadcast arriving at full volume over whatever you
 * were already listening to is startling, and turning something down after it
 * has already made you jump is too late. Quiet is easy to undo; loud is not.
 * Your own setting for someone survives and overrides this.
 */
export const DEFAULT_PEER_AUDIO: PeerAudio = { volume: 0.25, muted: false }

/**
 * One incoming audio stream, wired into its peer's channel.
 *
 * There is one of these per audio track a peer sends — screen audio and
 * microphone are separate tracks and have to stay separate all the way to the
 * gain node, because `createMediaStreamSource` reads only the FIRST audio
 * track of a stream. Putting both in one MediaStream silently drops one.
 */
interface Input {
  stream: MediaStream
  source: MediaStreamAudioSourceNode
  /** Kept alive so Chromium does not garbage-collect the receiver's stream. */
  sink: HTMLAudioElement
}

interface Channel {
  inputs: Input[]
  gain: GainNode
  analyser: AnalyserNode
  buffer: Float32Array<ArrayBuffer>
}

export class AudioMixer {
  private context: AudioContext | null = null
  private master: GainNode | null = null
  private readonly channels = new Map<string, Channel>()
  /**
   * Settings live here, NOT on the channel, and outlive it.
   *
   * A channel only exists once a peer actually sends audio. Keeping the
   * setting on the channel meant turning someone down before they unmuted —
   * or while they shared a silent screen — silently did nothing, and the
   * slider sat frozen because the session had nothing to store.
   */
  private readonly settings = new Map<string, PeerAudio>()
  private masterVolume = 1
  private outputDevice = ''

  /**
   * Must be called from a user gesture the first time, or the AudioContext
   * starts suspended and nothing is audible.
   */
  private ensureContext(): AudioContext {
    if (!this.context) {
      this.context = new AudioContext({ latencyHint: 'interactive' })
      this.master = this.context.createGain()
      this.master.gain.value = this.masterVolume
      this.master.connect(this.context.destination)
    }
    if (this.context.state === 'suspended') void this.context.resume()
    return this.context
  }

  resume(): void {
    this.ensureContext()
  }

  /**
   * Route everything one peer sends through a single volume control.
   *
   * Takes ALL of their audio streams at once rather than one at a time. The
   * one-at-a-time version looked fine and was broken: each call began by
   * tearing down the previous channel, so a peer sending screen audio and
   * microphone ended up with only whichever arrived last — and since fixed
   * slots mean the microphone transceiver fires even when nobody has a
   * microphone on, the last arrival was a silent track that wiped the screen
   * audio. Viewers watched the picture and heard nothing.
   */
  attach(peerId: string, streams: MediaStream[]): void {
    const live = streams.filter((stream) => stream.getAudioTracks().length > 0)
    if (live.length === 0) {
      this.detach(peerId)
      return
    }

    this.detach(peerId)

    const context = this.ensureContext()
    const gain = context.createGain()
    const analyser = context.createAnalyser()
    // Small FFT: we want a responsive level meter, not a spectrum.
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.6

    gain.connect(analyser)
    if (this.master) gain.connect(this.master)

    const inputs = live.map((stream) => {
      const source = context.createMediaStreamSource(stream)
      source.connect(gain)

      // Chromium will not pull from a MediaStreamAudioSourceNode unless the
      // underlying stream is also consumed by a media element. Muted so it
      // never double-plays past the gain stage.
      const sink = new Audio()
      sink.srcObject = stream
      sink.muted = true
      sink.autoplay = true
      void sink.play().catch(() => undefined)
      if (this.outputDevice) void this.applySink(sink)

      return { stream, source, sink }
    })

    // Re-apply whatever this peer was already set to.
    const settings = this.peerAudio(peerId)
    gain.gain.value = settings.muted ? 0 : settings.volume

    this.channels.set(peerId, {
      inputs,
      gain,
      analyser,
      buffer: new Float32Array(analyser.fftSize)
    })
  }

  detach(peerId: string): void {
    const channel = this.channels.get(peerId)
    if (!channel) return
    try {
      for (const input of channel.inputs) input.source.disconnect()
      channel.gain.disconnect()
      channel.analyser.disconnect()
    } catch {
      // Already torn down.
    }
    for (const input of channel.inputs) input.sink.srcObject = null
    this.channels.delete(peerId)
    // Settings deliberately survive: if they start sharing again, they come
    // back at the volume you chose.
  }

  /**
   * Always records the setting and always returns it, whether or not the peer
   * is currently audible. The gain node is updated only if one exists.
   */
  setPeerAudio(peerId: string, patch: Partial<PeerAudio>): PeerAudio {
    const next = { ...this.peerAudio(peerId), ...patch }
    this.settings.set(peerId, next)

    const channel = this.channels.get(peerId)
    if (channel) {
      // Short ramp instead of a step, so a volume change does not click.
      const context = this.ensureContext()
      const target = next.muted ? 0 : next.volume
      channel.gain.gain.setTargetAtTime(target, context.currentTime, 0.015)
    }
    return next
  }

  peerAudio(peerId: string): PeerAudio {
    return { ...(this.settings.get(peerId) ?? DEFAULT_PEER_AUDIO) }
  }

  /** True when this peer is actually sending audio we can act on. */
  isAudible(peerId: string): boolean {
    return this.channels.has(peerId)
  }

  /**
   * Route playback to a specific output device.
   *
   * Applied to the per-peer sink elements, which is where the audio actually
   * leaves: an AudioContext cannot be re-pointed after creation in Chromium,
   * but the elements feeding it can.
   */
  async setOutputDevice(deviceId: string): Promise<void> {
    this.outputDevice = deviceId
    for (const channel of this.channels.values()) {
      for (const input of channel.inputs) await this.applySink(input.sink)
    }
  }

  private async applySink(sink: HTMLAudioElement): Promise<void> {
    const target = sink as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }
    if (typeof target.setSinkId !== 'function') return
    try {
      await target.setSinkId(this.outputDevice)
    } catch (error) {
      // A device can vanish between listing and selection.
      console.warn('[audio] setSinkId failed:', error)
    }
  }

  setMasterVolume(volume: number): void {
    this.masterVolume = volume
    if (this.master && this.context) {
      this.master.gain.setTargetAtTime(volume, this.context.currentTime, 0.015)
    }
  }

  /**
   * Instantaneous RMS level, 0..1, for one peer. Call from a rAF loop — it is
   * cheap and allocation-free.
   */
  level(peerId: string): number {
    const channel = this.channels.get(peerId)
    if (!channel) return 0
    channel.analyser.getFloatTimeDomainData(channel.buffer)
    let sum = 0
    for (let i = 0; i < channel.buffer.length; i++) {
      sum += channel.buffer[i] * channel.buffer[i]
    }
    const rms = Math.sqrt(sum / channel.buffer.length)
    // Perceptual curve: raw RMS barely moves for normal speech.
    return Math.min(1, rms * 3.2)
  }

  dispose(): void {
    for (const peerId of [...this.channels.keys()]) this.detach(peerId)
    this.settings.clear()
    void this.context?.close()
    this.context = null
    this.master = null
  }
}
