/**
 * Turns the PCM stream coming from the native per-process capturer back into a
 * `MediaStreamTrack` that WebRTC can send.
 *
 * The native side (src/main/process-audio.ts) hands us interleaved f32 frames
 * over IPC. We buffer them and play them out through a ScriptProcessor-free
 * path: a `MediaStreamAudioDestinationNode` fed by an AudioWorklet.
 *
 * A jitter cushion is unavoidable here because IPC delivery is bursty while
 * audio playout is not. It is a real buffer, not a hope: playout waits until
 * the cushion has filled, and refills it after a dropout instead of limping
 * along one sample from empty. Without that, every hiccup in the main process
 * — and the main process does other things — came out as a click.
 */

/**
 * Jitter buffer shape, after reading how Discord's engine does it.
 *
 * `discord_voice.node` is libwebrtc, and its audio playout runs through
 * NetEq (`modules/audio_coding/neteq/*` survives in the binary, alongside a
 * `setMinimumOutputDelay` knob exposed all the way up to JavaScript). The
 * thing worth copying is not the algorithm but its two principles:
 *
 *   - The target delay ADAPTS. It is not a constant chosen once by whoever
 *     wrote the file; it grows on a machine that keeps starving and settles
 *     back down on one that does not.
 *   - Running dry never produces a hole. NetEq time-stretches. The previous
 *     version here re-primed on every underrun, which meant each hiccup
 *     turned into a flat 60 ms of silence — louder and more noticeable than
 *     the glitch it was trying to prevent. That is the "mau contato".
 *
 * This is not NetEq; there is no WSOLA here. It takes the two principles and
 * nothing else: an adaptive target, and a short fade instead of a cliff.
 */

/** Starting cushion. Raised automatically when this machine cannot hold it. */
const TARGET_START_MS = 80
/** Never cushion less than this, nor more. */
const TARGET_MIN_MS = 60
const TARGET_MAX_MS = 320
/** Added to the target each time playout runs dry. */
const TARGET_STEP_MS = 30
/** Backlog beyond the target that is simply too much delay to carry. */
const TARGET_SLACK_MS = 160
/** Fade applied when the buffer runs dry, instead of jumping to zero. */
const FADE_MS = 4

const WORKLET_SOURCE = `
class PcmQueueProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const o = options.processorOptions
    this.perMs = o.perMs
    this.target = o.targetStart
    this.targetMin = o.targetMin
    this.targetMax = o.targetMax
    this.targetStep = o.targetStep
    this.slack = o.slack
    this.fadeSamples = o.fadeSamples

    this.queue = []
    this.offset = 0
    this.queued = 0
    this.priming = true
    // Last sample per channel, so a fade starts from where the audio was
    // rather than from wherever zero happens to be.
    this.tail = new Float32Array(8)
    this.fadeLeft = 0
    this.cleanQuanta = 0

    this.port.onmessage = (event) => {
      if (event.data === 'flush') {
        this.queue = []
        this.offset = 0
        this.queued = 0
        this.priming = true
        return
      }
      const chunk = new Float32Array(event.data)
      this.queue.push(chunk)
      this.queued += chunk.length

      // Too far behind to be worth keeping: this is delay, not safety.
      const ceiling = this.target + this.slack
      while (this.queued > ceiling && this.queue.length > 1) {
        const old = this.queue.shift()
        this.queued -= old.length - this.offset
        this.offset = 0
      }
    }
  }

  // Hold the previous value and bleed it out. Four milliseconds of decay is
  // inaudible; a step to zero is a click, and that click is the complaint.
  fade(output, channels, from, to) {
    for (let frame = from; frame < to; frame++) {
      const k = this.fadeLeft > 0 ? this.fadeLeft / this.fadeSamples : 0
      for (let c = 0; c < channels; c++) output[c][frame] = this.tail[c] * k
      if (this.fadeLeft > 0) this.fadeLeft--
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0]
    const channels = output.length
    const frames = output[0].length

    if (this.priming) {
      if (this.queued < this.target) {
        this.fade(output, channels, 0, frames)
        return true
      }
      this.priming = false
      this.cleanQuanta = 0
    }

    for (let frame = 0; frame < frames; frame++) {
      if (this.queue.length === 0) {
        // Ran dry. Raise the cushion — this machine has told us the current
        // one is not enough — and ease out rather than cutting.
        this.target = Math.min(this.targetMax, this.target + this.targetStep)
        this.fadeLeft = this.fadeSamples
        this.fade(output, channels, frame, frames)
        this.priming = true
        return true
      }

      const chunk = this.queue[0]
      for (let c = 0; c < channels; c++) {
        const v = chunk[this.offset + c] ?? 0
        output[c][frame] = v
        this.tail[c] = v
      }
      this.offset += channels
      this.queued -= channels
      if (this.offset >= chunk.length) {
        this.queue.shift()
        this.offset = 0
      }
    }

    // A long clean run means the cushion is larger than this machine needs,
    // and cushion is latency. Give it back slowly — far more slowly than it
    // was taken, so one good minute cannot undo what a bad second taught us.
    this.cleanQuanta++
    if (this.cleanQuanta > 1500) {
      this.cleanQuanta = 0
      this.target = Math.max(this.targetMin, this.target - this.perMs)
    }
    return true
  }
}
registerProcessor('pcm-queue', PcmQueueProcessor)
`

export interface PcmTrackHandle {
  track: MediaStreamTrack
  stream: MediaStream
  push: (chunk: ArrayBuffer) => void
  close: () => void
}

export async function createPcmTrack(
  sampleRate: number,
  channels: number
): Promise<PcmTrackHandle> {
  const context = new AudioContext({ sampleRate, latencyHint: 'interactive' })
  const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' })
  const url = URL.createObjectURL(blob)
  try {
    await context.audioWorklet.addModule(url)
  } finally {
    URL.revokeObjectURL(url)
  }

  const ms = (value: number): number => Math.round((sampleRate * value) / 1000) * channels

  const node = new AudioWorkletNode(context, 'pcm-queue', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [channels],
    processorOptions: {
      perMs: Math.round(sampleRate / 1000) * channels,
      targetStart: ms(TARGET_START_MS),
      targetMin: ms(TARGET_MIN_MS),
      targetMax: ms(TARGET_MAX_MS),
      targetStep: ms(TARGET_STEP_MS),
      slack: ms(TARGET_SLACK_MS),
      fadeSamples: Math.round((sampleRate * FADE_MS) / 1000)
    }
  })
  const destination = context.createMediaStreamDestination()
  node.connect(destination)

  const track = destination.stream.getAudioTracks()[0]

  return {
    track,
    stream: destination.stream,
    push: (chunk) => node.port.postMessage(chunk, [chunk]),
    close: () => {
      node.port.postMessage('flush')
      node.disconnect()
      void context.close()
      track.stop()
    }
  }
}
