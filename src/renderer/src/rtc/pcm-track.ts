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

/**
 * How far the backlog may sit from its target before the rate is nudged.
 *
 * The capture clock and the playback clock are different pieces of hardware
 * that both call themselves 48 kHz. They are not, quite, and the difference
 * accumulates: one direction drains the buffer until it underruns, the other
 * fills it until the oldest audio is discarded. Both are audible, and an
 * adaptive target does not help — it changes how often the artefact happens,
 * not whether it happens.
 *
 * NetEq's answer is to stretch time continuously. This is the cheap version
 * of the same idea: once the backlog has drifted past this margin, drop or
 * repeat exactly ONE frame per render quantum. That is a 0.8% correction
 * against a drift measured in hundredths of a percent, applied a frame at a
 * time, and a single frame at 48 kHz is 20 microseconds — far below anything
 * a person can hear. Drift stops accumulating, so it never reaches the point
 * of becoming a gap.
 */
const DRIFT_MARGIN_MS = 12

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
    this.driftMargin = o.driftMargin
    this.underruns = 0
    this.overflows = 0
    this.corrections = 0
    this.reportAt = 0

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
        this.overflows++
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

  // Advance past one frame without emitting it. Used to shed drift.
  skipFrame(channels) {
    if (this.queue.length === 0) return
    const chunk = this.queue[0]
    this.offset += channels
    this.queued -= channels
    if (this.offset >= chunk.length) {
      this.queue.shift()
      this.offset = 0
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

    // Correct the clocks before reading, never by more than a frame.
    //
    // Too full: shed one frame. Too empty: emit the previous frame twice, by
    // simply not advancing after it is written. Either way the backlog walks
    // back toward its target instead of running to one of the two edges.
    let repeatFrame = false
    const drift = this.queued - this.target
    if (drift > this.driftMargin) {
      this.skipFrame(channels)
      this.corrections++
    } else if (drift < -this.driftMargin && this.queue.length > 0) {
      repeatFrame = true
      this.corrections++
    }

    for (let frame = 0; frame < frames; frame++) {
      if (this.queue.length === 0) {
        // Ran dry. Raise the cushion — this machine has told us the current
        // one is not enough — and ease out rather than cutting.
        this.underruns++
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

      // Hold position for exactly one frame when we are running short; the
      // same twenty microseconds of audio simply plays twice.
      if (repeatFrame) {
        repeatFrame = false
        continue
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

    // Say what actually happened, so the next report of crackling is a
    // reading instead of an argument.
    if (currentTime > this.reportAt) {
      this.reportAt = currentTime + 15
      this.port.postMessage({
        underruns: this.underruns,
        overflows: this.overflows,
        corrections: this.corrections,
        targetMs: Math.round((this.target / this.perMs))
      })
      this.underruns = 0
      this.overflows = 0
      this.corrections = 0
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
      driftMargin: ms(DRIFT_MARGIN_MS),
      fadeSamples: Math.round((sampleRate * FADE_MS) / 1000)
    }
  })
  const destination = context.createMediaStreamDestination()
  node.connect(destination)

  node.port.onmessage = (event) => {
    const health = event.data as {
      underruns: number
      overflows: number
      corrections: number
      targetMs: number
    }
    // Silence is the normal case and does not deserve a line.
    if (health.underruns === 0 && health.overflows === 0) return
    console.warn(
      `[pcm] ${health.underruns} falhas, ${health.overflows} descartes, ` +
        `${health.corrections} correcoes de relogio, almofada ${health.targetMs}ms`
    )
  }

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
