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

/** Cushion before playout starts, and again after any underrun. */
const PRIME_MS = 60
/** Backlog above which the oldest audio is dropped to get latency back. */
const MAX_LAG_MS = 240

const WORKLET_SOURCE = `
class PcmQueueProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const o = options.processorOptions
    this.primeSamples = o.primeSamples
    this.maxSamples = o.maxSamples
    this.queue = []
    this.offset = 0
    this.queued = 0
    // Start primed-off: output silence until the cushion exists.
    this.priming = true

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

      // Too far behind real time to be worth keeping. Dropping back to the
      // cushion costs one glitch; carrying the backlog costs permanent delay.
      while (this.queued > this.maxSamples && this.queue.length > 1) {
        const old = this.queue.shift()
        this.queued -= old.length - this.offset
        this.offset = 0
      }
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0]
    const channels = output.length
    const frames = output[0].length

    if (this.priming) {
      if (this.queued < this.primeSamples) {
        for (let c = 0; c < channels; c++) output[c].fill(0)
        return true
      }
      this.priming = false
    }

    for (let frame = 0; frame < frames; frame++) {
      if (this.queue.length === 0) {
        // Underrun. Fill the rest with silence and rebuild the cushion rather
        // than running on empty and clicking on every single buffer.
        for (let f = frame; f < frames; f++) {
          for (let c = 0; c < channels; c++) output[c][f] = 0
        }
        this.priming = true
        return true
      }

      const chunk = this.queue[0]
      for (let c = 0; c < channels; c++) {
        output[c][frame] = chunk[this.offset + c] ?? 0
      }
      this.offset += channels
      this.queued -= channels
      if (this.offset >= chunk.length) {
        this.queue.shift()
        this.offset = 0
      }
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

  const node = new AudioWorkletNode(context, 'pcm-queue', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [channels],
    processorOptions: {
      primeSamples: Math.round((sampleRate * PRIME_MS) / 1000) * channels,
      maxSamples: Math.round((sampleRate * MAX_LAG_MS) / 1000) * channels
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
