/**
 * Turns the PCM stream coming from the native per-process capturer back into a
 * `MediaStreamTrack` that WebRTC can send.
 *
 * The native side (src/main/process-audio.ts) hands us interleaved f32 frames
 * over IPC. We buffer them and play them out through a ScriptProcessor-free
 * path: a `MediaStreamAudioDestinationNode` fed by an AudioWorklet.
 *
 * A jitter cushion is unavoidable here because IPC delivery is bursty while
 * audio playout is not. One 40 ms cushion is cheap next to the alternative,
 * which is a crackle every time the main process is briefly busy.
 */

const WORKLET_SOURCE = `
class PcmQueueProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.queue = []
    this.offset = 0
    this.port.onmessage = (event) => {
      if (event.data === 'flush') {
        this.queue = []
        this.offset = 0
        return
      }
      this.queue.push(new Float32Array(event.data))
      // Hard cap: if the consumer stalls, drop the oldest audio rather than
      // growing without bound and drifting further behind real time.
      while (this.queue.length > 64) this.queue.shift()
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0]
    const channels = output.length
    const frames = output[0].length

    for (let frame = 0; frame < frames; frame++) {
      if (this.queue.length === 0) {
        for (let c = 0; c < channels; c++) output[c][frame] = 0
        continue
      }
      const chunk = this.queue[0]
      for (let c = 0; c < channels; c++) {
        output[c][frame] = chunk[this.offset + c] ?? 0
      }
      this.offset += channels
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
    outputChannelCount: [channels]
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
