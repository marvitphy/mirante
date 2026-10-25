/// <reference lib="webworker" />
import createRNNWasmModuleSync from '@jitsi/rnnoise-wasm/dist/rnnoise-sync.js'

/**
 * RNNoise, running on the audio thread.
 *
 * The browser's own `noiseSuppression` is a stationary-noise estimator: it
 * learns the steady floor of a room and subtracts it, which handles a fan or
 * a hiss and does nothing about a keyboard, a chair, a dog, or a television
 * in the same room. RNNoise is a small recurrent network trained on speech
 * against noise, so it decides per band whether what it is hearing is a
 * voice, and that is a different question with a different answer.
 *
 * This is the same library and the same arrangement Jitsi Meet ships — the
 * `-sync` build exists precisely because an AudioWorklet has no `fetch` and
 * no async module loading, so the wasm arrives base64 inside the bundle.
 *
 * ## Why this is opt-in
 *
 * See the header of `pcm-track.ts`. An AudioWorklet runs JavaScript on the
 * renderer's audio thread against a 2.7 ms deadline, in the same process
 * that may be encoding 1080p60 in software. That is a real risk and it is
 * why this is one setting among three rather than the new default: the rest
 * of the microphone chain is native nodes with no JavaScript on that thread.
 */

const FRAME = 480

/**
 * RNNoise works in int16 units rather than the -1..1 the graph carries.
 * Scaling is not optional: handed -1..1 the network sees near-silence and
 * passes it through unchanged, which looks exactly like "the setting does
 * nothing".
 */
const SCALE = 32768

/**
 * How much of the original survives while someone is SPEAKING.
 *
 * Raw RNNoise applies the same suppression to speech as to silence, and on
 * a voice that reads as a processed, slightly underwater quality — the
 * "corta demais" half of the complaint. Noise riding under a voice is
 * perceptually masked by the voice anyway, so there is little to win there
 * and real naturalness to lose. Commercial suppressors all back off during
 * speech for this reason.
 */
const SPEECH_DRY = 0.18

/**
 * What is left between words.
 *
 * Not zero. Absolute digital silence between words is not what a quiet room
 * sounds like, and the ear reads the gap itself as the line cutting out —
 * which is the other half of the same complaint. A floor this far down is
 * inaudible as noise and audible as presence.
 */
const NOISE_FLOOR = 0.015

/**
 * Asymmetric smoothing on the voice-activity probability.
 *
 * Fast to open, slow to close. A slow attack eats the consonant that starts
 * a word — exactly the sound that carries intelligibility — while a fast
 * release chops the tail off every sentence and pumps between syllables.
 * These are per 10 ms frame.
 */
const VAD_ATTACK = 0.6
const VAD_RELEASE = 0.05

interface RnnModule {
  HEAPF32: Float32Array
  _malloc: (bytes: number) => number
  _free: (ptr: number) => void
  _rnnoise_create: () => number
  _rnnoise_destroy: (state: number) => void
  _rnnoise_process_frame: (state: number, out: number, input: number) => number
}

class RnnoiseProcessor extends AudioWorkletProcessor {
  private readonly rnn: RnnModule
  private readonly state: number
  private readonly ptr: number
  private readonly offset: number

  /** Samples waiting to make up a whole 480-frame. */
  private readonly pending = new Float32Array(FRAME)
  private pendingLength = 0

  /** The same frame before denoising, for the speech blend. */
  private readonly dry = new Float32Array(FRAME)

  /** Smoothed voice-activity probability, 0..1. */
  private speech = 0

  /**
   * Processed samples waiting to be handed out 128 at a time.
   *
   * A frame arrives 480 samples at a time and leaves 128 at a time, so there
   * is always a remainder. Sized generously — a quantum can never consume
   * more than it adds, so this only has to absorb the 480-vs-128 mismatch.
   */
  private readonly ready = new Float32Array(FRAME * 4)
  /**
   * Start one frame ahead, on silence.
   *
   * The cushion has to come from somewhere, and without this it is taken
   * out of the first fifth of a second of speech: measured, a 992-sample
   * gap at the very start of every stream. `ready` is already zeroed, so
   * claiming a frame of it costs one constant 10 ms of latency instead.
   */
  private readyLength = FRAME

  private enabled = true

  constructor() {
    super()
    this.rnn = createRNNWasmModuleSync() as RnnModule
    this.state = this.rnn._rnnoise_create()
    this.ptr = this.rnn._malloc(FRAME * 4)
    this.offset = this.ptr >> 2
    this.port.onmessage = (event: MessageEvent): void => {
      const data = event.data as { enabled?: boolean } | null
      if (data && typeof data.enabled === 'boolean') this.enabled = data.enabled
    }
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0]
    const output = outputs[0]?.[0]
    if (!output) return true

    // No input yet (the source is still connecting) — emit silence rather
    // than whatever was left in the output buffer from last time.
    if (!input) {
      output.fill(0)
      return true
    }

    if (!this.enabled) {
      output.set(input)
      return true
    }

    for (let i = 0; i < input.length; i++) {
      this.pending[this.pendingLength++] = input[i]
      if (this.pendingLength === FRAME) {
        this.denoise()
        this.pendingLength = 0
      }
    }

    // Until the first full frame has been through, there is nothing to give
    // back. That is the 10 ms this costs, paid once at the start.
    if (this.readyLength < output.length) {
      output.fill(0)
      return true
    }

    output.set(this.ready.subarray(0, output.length))
    this.ready.copyWithin(0, output.length, this.readyLength)
    this.readyLength -= output.length
    return true
  }

  /**
   * Denoise one frame, and decide how hard to apply it.
   *
   * The network returns a voice-activity probability alongside the cleaned
   * audio, and using it to vary the amount is the difference between a
   * suppressor people turn off and one they forget is on. Full strength
   * between words, eased off over a voice.
   */
  private denoise(): void {
    const heap = this.rnn.HEAPF32
    for (let i = 0; i < FRAME; i++) {
      this.dry[i] = this.pending[i]
      heap[this.offset + i] = this.pending[i] * SCALE
    }

    const vad = this.rnn._rnnoise_process_frame(this.state, this.ptr, this.ptr)
    const rate = vad > this.speech ? VAD_ATTACK : VAD_RELEASE
    this.speech += (vad - this.speech) * rate

    // Between words the floor is all that is left of the room; over a voice
    // a fifth of the original comes back, which is what keeps breath and
    // consonants from sounding synthesised.
    const dryMix = NOISE_FLOOR + (SPEECH_DRY - NOISE_FLOOR) * this.speech
    const wetMix = 1 - dryMix * this.speech

    for (let i = 0; i < FRAME; i++) {
      this.ready[this.readyLength + i] =
        (heap[this.offset + i] / SCALE) * wetMix + this.dry[i] * dryMix
    }
    this.readyLength += FRAME
  }
}

registerProcessor('rnnoise', RnnoiseProcessor)
