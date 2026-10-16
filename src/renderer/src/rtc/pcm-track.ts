/**
 * Turns the PCM stream coming from the native per-process capturer into a
 * `MediaStreamTrack` that WebRTC can send.
 *
 * ## Why there is no AudioContext here any more
 *
 * The first three versions of this file were an AudioWorklet feeding a
 * `MediaStreamAudioDestinationNode`, and all three crackled. Each round found
 * a real defect — a mixing loop that consumed slower than it produced, a
 * cushion that filled gaps with silence instead of easing out of them, two
 * clocks drifting apart with nothing reconciling them — and fixing each one
 * changed the texture of the problem without ending it.
 *
 * The reason is structural. An AudioWorklet runs on the renderer's audio
 * thread, on a deadline: 128 frames must be produced every 2.7 ms or the
 * output has a hole in it. That thread lives in the same process that is
 * encoding 1080p60 video, in software, because Chromium exposes no hardware
 * encoder to WebRTC here. Under that load the deadline is missed, and no
 * amount of buffering upstream fixes a consumer that stops consuming — it
 * only decides whether the hole is filled with silence, a fade, or a repeat.
 *
 * `MediaStreamTrackGenerator` removes the deadline instead of padding it.
 * Audio is handed over as timestamped `AudioData` and the track carries it;
 * nothing has to wake up on time, so nothing can be late. The capture clock
 * becomes the track's clock, which is also the honest answer to drift: there
 * is now only one clock on this side, and WebRTC's receiver already has
 * NetEq for the other.
 *
 * What is gone with it: the worklet, the jitter buffer, the adaptive target,
 * the drift correction, and the fade. None of them were wrong. They were all
 * compensating for a scheduling problem that no longer exists.
 */

/**
 * Chromium ships these without TypeScript DOM definitions. Only the parts
 * used here are declared.
 */
declare class MediaStreamTrackGenerator extends MediaStreamTrack {
  constructor(init: { kind: 'audio' | 'video' })
  readonly writable: WritableStream<AudioData>
}

declare class AudioData {
  constructor(init: {
    format: 'f32'
    sampleRate: number
    numberOfFrames: number
    numberOfChannels: number
    timestamp: number
    data: Float32Array
  })
  close(): void
}

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
  const generator = new MediaStreamTrackGenerator({ kind: 'audio' })
  const writer = generator.writable.getWriter()

  /**
   * Frames handed over so far, which is what the timestamps are built from.
   *
   * Counting rather than reading a clock is deliberate: it makes the
   * timeline exactly as long as the audio actually is. A wall clock would
   * drift against the capture device and leave gaps or overlaps that the
   * receiver would then have to paper over.
   */
  let framesWritten = 0
  let closed = false
  let dropped = 0
  let reported = 0

  /**
   * Writes are serialised through one chain.
   *
   * `write` resolves when the track has taken the data, and overlapping
   * writes are not allowed on a single writer. Chaining keeps the IPC
   * callback non-blocking while still respecting that.
   */
  let chain: Promise<void> = Promise.resolve()

  return {
    track: generator,
    stream: new MediaStream([generator]),

    push: (chunk) => {
      if (closed) return
      const samples = new Float32Array(chunk)
      const frames = Math.floor(samples.length / channels)
      if (frames === 0) return

      const timestamp = Math.round((framesWritten / sampleRate) * 1_000_000)
      framesWritten += frames

      chain = chain
        .then(async () => {
          if (closed) return
          const data = new AudioData({
            format: 'f32',
            sampleRate,
            numberOfFrames: frames,
            numberOfChannels: channels,
            timestamp,
            data: samples
          })
          try {
            await writer.write(data)
          } finally {
            data.close()
          }
        })
        .catch(() => {
          // A refused write means the track is going away, or the consumer
          // is gone. Count it; never let it break the chain for the rest.
          dropped++
          if (dropped - reported >= 50) {
            reported = dropped
            console.warn(`[pcm] ${dropped} blocos recusados pela track`)
          }
        })
    },

    close: () => {
      if (closed) return
      closed = true
      void chain.then(() => writer.close()).catch(() => undefined)
      generator.stop()
    }
  }
}
