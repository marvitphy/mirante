import rnnoiseUrl from './rnnoise-worklet.ts?worker&url'

/**
 * Everything that happens to your voice between the microphone and the wire.
 *
 * Until now there was nothing here: `getUserMedia` handed back a track and
 * that track went straight into a sender. Three separate requests all land
 * in the same place — stronger noise suppression, a level for your own
 * microphone, and seeing yourself light up when you talk the way you see
 * everyone else — and all three need the signal to pass through something
 * we own on the way out.
 *
 * ## Shape
 *
 *     getUserMedia (AEC · NS · AGC · mono, done at capture)
 *       → source
 *       → highpass 80 Hz
 *       → gain            ← your input level
 *       → [rnnoise]       ← only on "forte"
 *       → analyser        ← the ring on your tile, the meter in settings
 *       → destination     → the track that is actually sent
 *
 * The chain exists whenever the microphone is on, not only when something
 * in it is non-default. One topology is worth more than the handful of
 * native nodes it costs: a level that needs a track swap to take effect is
 * a level you cannot drag, and a meter that only appears once you have
 * already changed a setting cannot help you decide whether to.
 *
 * Note what is NOT in that list. Echo cancellation, the browser's own noise
 * suppression and automatic gain are applied by Chromium during capture,
 * before the track is handed over, so they are constraints rather than
 * nodes and nothing here can undo them.
 *
 * ## The deadline question
 *
 * `pcm-track.ts` documents why an AudioWorklet was removed from the
 * loopback path: JavaScript on the audio thread against a 2.7 ms deadline,
 * in a process that may be encoding 1080p60 in software, is a bet that
 * loses under load. Everything above except RNNoise is a native node — the
 * audio thread runs no JavaScript for it — which is the reason RNNoise is
 * a setting you turn on rather than the behaviour everyone gets.
 */

/**
 * How hard to work on the noise.
 *
 * `standard` is what the app has always done and stays the default. Someone
 * whose voice already sounds good should not find it changed because a new
 * version shipped.
 */
export type NoiseSuppression = 'off' | 'standard' | 'strong'

/**
 * Capture constraints for a level.
 *
 * `off` also releases automatic gain, because the two together are a
 * contradiction: AGC spends its time undoing exactly the input level the
 * person just set by hand. Echo cancellation stays on at every level —
 * echo is inflicted on the room, not on the person causing it, so it is
 * not really theirs to switch off.
 */
export function micConstraints(
  deviceId: string,
  level: NoiseSuppression
): MediaTrackConstraints {
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    echoCancellation: true,
    noiseSuppression: level !== 'off',
    autoGainControl: level !== 'off',
    channelCount: 1
  }
}

interface Chain {
  context: AudioContext
  source: MediaStreamAudioSourceNode
  highpass: BiquadFilterNode
  gain: GainNode
  rnnoise: AudioWorkletNode | null
  analyser: AnalyserNode
  destination: MediaStreamAudioDestinationNode
  raw: MediaStream
  out: MediaStream
  /**
   * Whether the monitor tap is currently wired to the speakers.
   *
   * Tracked rather than inferred. `AudioNode.disconnect(node)` THROWS
   * `InvalidAccessError` when the two were never connected, so "just
   * disconnect, it is harmless" is false — and the throw happened inside a
   * React cleanup, which takes the whole tree down with it. Closing the
   * settings dialog without touching the monitor blacked out the app.
   */
  monitoring: boolean
  buffer: Float32Array<ArrayBuffer>
}

let chain: Chain | null = null
let workletReady: Promise<boolean> | null = null

/**
 * Load the RNNoise module once per AudioContext.
 *
 * Resolves to false rather than throwing if it cannot be loaded. A noise
 * setting that fails to apply should cost you the noise reduction, not your
 * microphone.
 */
async function ensureWorklet(context: AudioContext): Promise<boolean> {
  if (!workletReady) {
    workletReady = context.audioWorklet
      .addModule(rnnoiseUrl)
      .then(() => true)
      .catch((error: unknown) => {
        console.warn('[mic] rnnoise indisponível:', error)
        return false
      })
  }
  return workletReady
}

/**
 * Open the microphone and return the stream to send.
 *
 * The raw capture is kept privately — it has to be stopped too, and only
 * this module knows it exists.
 */
export async function openMic(
  deviceId: string,
  level: NoiseSuppression,
  gain: number
): Promise<MediaStream> {
  // Acquire BEFORE tearing down. Closing first and then failing to open —
  // a virtual camera's microphone still listed after its phone walked off,
  // a driver busy in another app — would leave the microphone dead, the
  // senders holding a stopped track, and the button still lit. The old
  // device-switch path got this right and it must not be lost here.
  const raw = await navigator.mediaDevices.getUserMedia({
    audio: micConstraints(deviceId, level)
  })
  closeMic()

  // 48 kHz explicitly: RNNoise is trained at that rate and has no resampler,
  // and a context that followed the hardware would quietly feed it 44.1.
  const context = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 })
  if (context.state === 'suspended') await context.resume()

  const source = context.createMediaStreamSource(raw)

  // Rumble, desk thumps, mains hum, the low end of a fan. A speaking voice
  // has nothing below 80 Hz worth keeping — even a deep one sits above it —
  // and anything down there is spending bitrate on inaudible energy.
  const highpass = context.createBiquadFilter()
  highpass.type = 'highpass'
  highpass.frequency.value = 80

  const gainNode = context.createGain()
  gainNode.gain.value = gain

  const analyser = context.createAnalyser()
  analyser.fftSize = 256
  analyser.smoothingTimeConstant = 0.6

  // Mono all the way out. The destination node defaults to stereo, which
  // would quietly undo the mono capture and hand the encoder two identical
  // channels to spend bits on.
  const destination = context.createMediaStreamDestination()
  destination.channelCount = 1
  destination.channelCountMode = 'explicit'

  const out = destination.stream
  const track = out.getAudioTracks()[0]
  // Tells Chromium's encoder what it is looking at, the audio counterpart of
  // the content hint the video senders already set.
  if (track && 'contentHint' in track) track.contentHint = 'speech'

  chain = {
    context,
    source,
    highpass,
    gain: gainNode,
    rnnoise: null,
    analyser,
    destination,
    raw,
    out,
    monitoring: false,
    buffer: new Float32Array(analyser.fftSize)
  }

  source.connect(highpass)
  highpass.connect(gainNode)
  await route(level)

  return out
}

/**
 * Wire the tail of the chain for a level, building the worklet if needed.
 *
 * Only the segment after `gain` ever changes, so the source, the filter and
 * the level survive a change of setting untouched.
 */
async function route(level: NoiseSuppression): Promise<void> {
  if (!chain) return
  const current = chain
  const { context, gain, analyser, destination } = current

  if (level === 'strong' && !current.rnnoise && (await ensureWorklet(context))) {
    // Loading the module takes long enough for the microphone to have been
    // closed and reopened underneath us. Identity, not existence: a chain
    // that merely EXISTS may be a different one, and wiring a node from the
    // old context into it reconnects a graph nobody is listening to.
    if (chain !== current) return
    try {
      current.rnnoise = new AudioWorkletNode(context, 'rnnoise', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1]
      })
    } catch (error) {
      console.warn('[mic] rnnoise não pôde ser criado:', error)
    }
  }

  if (chain !== current) return

  gain.disconnect()
  current.rnnoise?.disconnect()

  if (level === 'strong' && current.rnnoise) {
    gain.connect(current.rnnoise)
    current.rnnoise.connect(analyser)
  } else {
    gain.connect(analyser)
  }
  analyser.connect(destination)
}

/** Change the level on a live microphone, without replacing the track. */
export async function setNoiseSuppression(level: NoiseSuppression): Promise<void> {
  if (!chain) return
  await route(level)
}

/**
 * Which device the live chain is actually capturing from.
 *
 * Read from the RAW track. The outgoing one comes out of a destination node
 * and has no device of its own to report, so asking IT which microphone is
 * open answers "none" and makes every comparison look like a change.
 */
export function micDeviceId(): string {
  return chain?.raw.getAudioTracks()[0]?.getSettings().deviceId ?? ''
}

/**
 * Hear yourself, exactly as everyone else hears you.
 *
 * Tapped after the whole chain, so it carries the level and the noise
 * reduction rather than the raw capture — there is no point auditioning a
 * signal nobody receives.
 *
 * This is not a nicety. The one thing a person cannot do is hear their own
 * microphone, which is why "nobody can tell the difference" was the honest
 * report about a setting that genuinely does something: there was no way to
 * check. Every mixing desk ever built has this button.
 *
 * Echo cancellation is on, so speakers are survivable, but headphones are
 * still the sane way to use it.
 */
export function setMonitor(on: boolean, deviceId = ''): void {
  if (!chain || chain.monitoring === on) return
  if (on) {
    // Out of the same speakers as everyone else's voices. This context is
    // its own, so it needs pointing on its own — otherwise auditioning your
    // microphone plays somewhere you are not listening, which looks exactly
    // like the monitor being broken.
    const context = chain.context as AudioContext & {
      setSinkId?: (id: string) => Promise<void>
    }
    if (typeof context.setSinkId === 'function') {
      void context.setSinkId(deviceId).catch((error: unknown) => {
        console.warn('[mic] saida do monitor recusada:', error)
      })
    }
    chain.analyser.connect(chain.context.destination)
  } else {
    chain.analyser.disconnect(chain.context.destination)
  }
  chain.monitoring = on
}

/** Your own input level, 0..2. Above 1 is a boost for a quiet microphone. */
export function setMicGain(gain: number): void {
  if (!chain) return
  chain.gain.gain.setTargetAtTime(gain, chain.context.currentTime, 0.02)
}

/**
 * How loud you are right now, 0..1, measured where the signal leaves.
 *
 * The same curve the peer meters use, so your ring and theirs mean the same
 * thing — which is the whole point of being able to see your own.
 */
export function micLevel(): number {
  if (!chain) return 0
  chain.analyser.getFloatTimeDomainData(chain.buffer)
  let sum = 0
  for (let i = 0; i < chain.buffer.length; i++) sum += chain.buffer[i] * chain.buffer[i]
  return Math.min(1, Math.sqrt(sum / chain.buffer.length) * 3.2)
}

/**
 * Whether the capture constraints for a level differ from another's.
 *
 * Node routing is live, but `noiseSuppression` and `autoGainControl` are
 * capture-time constraints, so moving between `off` and the other two is
 * the one change that does need the microphone reopened.
 */
export function needsReopen(from: NoiseSuppression, to: NoiseSuppression): boolean {
  return (from === 'off') !== (to === 'off')
}

export function closeMic(): void {
  if (!chain) return
  // Both of them. The raw capture is what holds the device open and keeps
  // the operating system's microphone indicator lit; stopping only the
  // outgoing track leaves it running and invisible.
  for (const track of chain.raw.getTracks()) track.stop()
  for (const track of chain.out.getTracks()) track.stop()
  if (chain.monitoring) chain.analyser.disconnect(chain.context.destination)
  chain.source.disconnect()
  chain.gain.disconnect()
  chain.rnnoise?.disconnect()
  chain.analyser.disconnect()
  void chain.context.close()
  chain = null
  workletReady = null
}
