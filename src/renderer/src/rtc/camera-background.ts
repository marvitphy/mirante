import { ImageSegmenter } from '@mediapipe/tasks-vision'
import wasmLoaderUrl from '@mediapipe/tasks-vision/vision_wasm_internal.js?url'
import wasmBinaryUrl from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url'

import modelUrl from '../assets/models/selfie_segmenter_landscape.tflite?url'

/**
 * Your own picture behind you, instead of your room.
 *
 * The webcam goes in, a `MediaStream` comes out, and nothing downstream can
 * tell the difference: the session publishes whatever track it is handed, so
 * peer-link and the encoder never learn that a background exists.
 *
 * Two rules shape everything here:
 *
 *   - OFF MEANS OFF. With no background the webcam passes straight through.
 *     MediaPipe is not even loaded — a 13 MB WASM module and a GPU context
 *     are not a price to pay for a feature nobody turned on.
 *   - NOTHING COMES FROM THE NETWORK. The WASM and the model are bundled. An
 *     app that phones Google's CDN every time you turn your camera on is an
 *     app that fails offline, behind a firewall, or the day that URL moves.
 *
 * The raw webcam stream is owned by the feed and never handed to the session.
 * That is load-bearing: `setCamera` and `swapDevice` stop the tracks of
 * whatever they replace, so if the session ever held the webcam itself,
 * turning the background on would switch the camera light off with it.
 */

// --- shape ----------------------------------------------------------------

/**
 * What the segmenter is fed. The landscape selfie model takes 256x144, so a
 * 1280x720 frame is shrunk to exactly that before inference — handing it the
 * full frame would only make MediaPipe do the same resize, and read the mask
 * back at full size, which is 25 times the pixels for no extra detail.
 */
const MASK_W = 256
const MASK_H = 144

/**
 * Confidence below LOW is background, above HIGH is you, and in between is a
 * smoothstep. The model's raw confidence is mushy across a wide band, which
 * reads as a halo; squeezing the band keeps the edge soft without the glow.
 */
const EDGE_LOW = 0.3
const EDGE_HIGH = 0.7

/** Blur on the upscaled mask, as a fraction of the frame width. */
const FEATHER = 1 / 320

/**
 * Past this many milliseconds per inference, segment every other frame and
 * reuse the mask in between. The model's speed swings with what else the
 * machine is doing — and Chromium deprioritises a minimised window — so this
 * keeps the picture at the camera's frame rate while only the cut-out updates
 * at half of it.
 */
const SEGMENT_BUDGET_MS = 16

/** What the published track promises. Matches the camera constraints. */
const OUTPUT_FPS = 30

/** How long a new background waits for its first frame before going live. */
const FIRST_FRAME_MS = 3000

// --- loading --------------------------------------------------------------

/**
 * Chromium's MediaStreamTrackProcessor is not in TypeScript's DOM library.
 * Only the part used here is declared.
 */
declare class MediaStreamTrackProcessor {
  constructor(init: { track: MediaStreamTrack; maxBufferSize?: number })
  readonly readable: ReadableStream<VideoFrame>
}

const FILESET: Parameters<typeof ImageSegmenter.createFromOptions>[0] = {
  wasmLoaderPath: wasmLoaderUrl,
  wasmBinaryPath: wasmBinaryUrl
}

let modelBytes: Promise<Uint8Array> | null = null
/** See createSegmenter — MediaPipe's loader is not safe to run twice at once. */
let loading: Promise<unknown> = Promise.resolve()

/**
 * Read a bundled file.
 *
 * XHR, not fetch: the packaged app is served from file:// inside app.asar,
 * and fetch refuses the file scheme outright. MediaPipe's own WASM loader
 * makes the same choice for the same reason. That is also why the model goes
 * in as a buffer instead of `modelAssetPath`, which MediaPipe would fetch.
 */
function readBytes(url: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('GET', url)
    xhr.responseType = 'arraybuffer'
    xhr.onload = () => {
      // file:// answers with status 0 on success.
      if ((xhr.status === 200 || xhr.status === 0) && xhr.response) {
        resolve(new Uint8Array(xhr.response as ArrayBuffer))
      } else {
        reject(new Error(`could not read ${url} (${xhr.status})`))
      }
    }
    xhr.onerror = () => reject(new Error(`could not read ${url}`))
    xhr.send()
  })
}

/**
 * A segmenter of our own.
 *
 * Calls are queued: MediaPipe loads its runtime by appending a <script> that
 * sets a global factory, then clears that global once used. Two loads in
 * flight — the camera picker's preview and the live camera reacting to the
 * same click — could each clear the other's factory. One at a time is cheap.
 *
 * GPU first. Without WebGL2 (a remote desktop, a blocklisted driver) the CPU
 * delegate still keeps up with 256x144 at 30 fps, and slow is better than
 * the feature silently not working.
 */
function createSegmenter(): Promise<ImageSegmenter> {
  const run = loading.then(async () => {
    modelBytes ??= readBytes(modelUrl)
    const model = await modelBytes.catch((error: unknown) => {
      modelBytes = null
      throw error
    })

    const open = (delegate: 'GPU' | 'CPU'): Promise<ImageSegmenter> =>
      ImageSegmenter.createFromOptions(FILESET, {
        // A copy: the buffer is moved into the WASM heap, and the cached one
        // must survive for the next segmenter.
        baseOptions: { modelAssetBuffer: model.slice(), delegate },
        runningMode: 'VIDEO',
        outputConfidenceMasks: true,
        outputCategoryMask: false
      })

    try {
      return await open('GPU')
    } catch (error) {
      console.warn('[background] GPU delegate failed, using CPU:', error)
      return open('CPU')
    }
  })
  loading = run.catch(() => undefined)
  return run
}

/**
 * Decode a picture once, up front, so the first frame never waits on it.
 *
 * Not `image.decode()`: Chromium ties that promise to the rendering pipeline,
 * and it never settles while the window is hidden. Turning the camera on with
 * the hotkey from inside a game would then wait forever for a picture.
 */
async function loadImage(url: string): Promise<ImageBitmap> {
  const image = new Image()
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('could not load the background picture'))
    image.src = url
  })
  return createImageBitmap(image)
}

function canvas2d(width: number, height: number): {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
} {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2d canvas unavailable')
  return { canvas, ctx }
}

/**
 * Resize a picked file for storage.
 *
 * Settings live in localStorage, which holds a few megabytes in total. A
 * phone photo is bigger than that on its own, and anything past the camera's
 * 1280x720 is detail the encoder throws away anyway. Never upscales.
 */
export async function encodeBackground(file: Blob): Promise<string> {
  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, 1280 / bitmap.width, 720 / bitmap.height)
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const { canvas, ctx } = canvas2d(width, height)
    ctx.drawImage(bitmap, 0, 0, width, height)
    return canvas.toDataURL('image/jpeg', 0.85)
  } finally {
    bitmap.close()
  }
}

// --- compositing ----------------------------------------------------------

/**
 * One running background. Exists only while a background is on.
 *
 * Driven by the camera's own frames through MediaStreamTrackProcessor, not by
 * requestAnimationFrame or a timer. Both of those are throttled the moment the
 * window is minimised or behind a game — which is exactly when this app gets
 * used — and the camera would freeze for everyone watching.
 */
class Compositor {
  /** What the session publishes. Never mirrored. */
  readonly output: MediaStream
  /**
   * What you see of yourself when mirroring: you flipped, the picture not.
   * Mirroring the whole frame with CSS would turn any text in the picture
   * backwards, and it is your picture — you know which way round it goes.
   */
  readonly mirrored: MediaStream
  mirror: boolean

  private readonly input: MediaStreamTrack
  private readonly reader: ReadableStreamDefaultReader<VideoFrame>
  private readonly small = canvas2d(MASK_W, MASK_H)
  private readonly mask = canvas2d(MASK_W, MASK_H)
  private maskPixels: ImageData
  private readonly person = canvas2d(1, 1)
  private readonly backdrop = canvas2d(1, 1)
  private readonly out = canvas2d(1, 1)
  private readonly flipped = canvas2d(1, 1)
  private image: ImageBitmap
  private imageUrl: string
  private lastTimestamp = 0
  /** Smoothed cost of one inference, for SEGMENT_BUDGET_MS. */
  private segmentCost = 0
  private skipped = false
  private closed = false
  private faulted = false
  private onFirstFrame: (() => void) | null = null
  /** Resolves on the first composited frame, so a swap never shows black. */
  readonly ready: Promise<void>

  private constructor(
    source: MediaStreamTrack,
    private readonly segmenter: ImageSegmenter,
    image: ImageBitmap,
    imageUrl: string,
    mirror: boolean,
    private readonly onClose: (compositor: Compositor) => void
  ) {
    this.image = image
    this.imageUrl = imageUrl
    this.mirror = mirror
    this.maskPixels = this.mask.ctx.createImageData(MASK_W, MASK_H)
    this.maskPixels.data.fill(255)

    const { width = 1280, height = 720 } = source.getSettings()
    this.resize(width, height)

    // A clone of our own: cancelling a processor's stream may end the track it
    // reads, and the webcam itself has to outlive any one background.
    this.input = source.clone()
    this.reader = new MediaStreamTrackProcessor({ track: this.input }).readable.getReader()

    this.output = this.out.canvas.captureStream(OUTPUT_FPS)
    this.mirrored = this.flipped.canvas.captureStream(OUTPUT_FPS)
    this.ready = new Promise((resolve) => (this.onFirstFrame = resolve))

    void this.pump()
  }

  static async open(
    source: MediaStreamTrack,
    imageUrl: string,
    mirror: boolean,
    onClose: (compositor: Compositor) => void
  ): Promise<Compositor> {
    const [segmenter, image] = await Promise.allSettled([
      createSegmenter(),
      loadImage(imageUrl)
    ])
    if (segmenter.status === 'rejected') throw segmenter.reason
    if (image.status === 'rejected') {
      segmenter.value.close()
      throw image.reason
    }
    return new Compositor(source, segmenter.value, image.value, imageUrl, mirror, onClose)
  }

  get isClosed(): boolean {
    return this.closed
  }

  async setImage(url: string): Promise<void> {
    if (this.imageUrl === url) return
    this.imageUrl = url
    const image = await loadImage(url)
    // Closed meanwhile, or another picture chosen while this one decoded.
    if (this.closed || this.imageUrl !== url) {
      image.close()
      return
    }
    this.image.close()
    this.image = image
    this.paintBackdrop()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    void this.reader.cancel().catch(() => undefined)
    this.input.stop()
    this.output.getTracks().forEach((t) => t.stop())
    this.mirrored.getTracks().forEach((t) => t.stop())
    this.segmenter.close()
    this.image.close()
    this.onFirstFrame?.()
    this.onClose(this)
  }

  private async pump(): Promise<void> {
    while (!this.closed) {
      let frame: VideoFrame | undefined
      try {
        const next = await this.reader.read()
        if (next.done) break
        frame = next.value
      } catch {
        break
      }

      try {
        this.draw(frame)
      } finally {
        frame.close()
      }
    }
    this.close()
  }

  private draw(frame: VideoFrame): void {
    const width = frame.displayWidth
    const height = frame.displayHeight
    if (width !== this.out.canvas.width || height !== this.out.canvas.height) {
      this.resize(width, height)
    }

    if (this.segmentCost < SEGMENT_BUDGET_MS || this.skipped) {
      const started = performance.now()
      try {
        this.segment(frame)
      } catch (error) {
        // A failed inference must neither freeze the camera nor reveal the
        // room: carry on compositing with the last good mask. Said once,
        // rather than every frame.
        if (!this.faulted) console.warn('[background] segmentation failed:', error)
        this.faulted = true
      }
      this.segmentCost = this.segmentCost * 0.8 + (performance.now() - started) * 0.2
      this.skipped = false
    } else {
      this.skipped = true
    }

    // You, cut out: the feathered mask, then the frame kept only where the
    // mask is opaque. Upscaling a 256x144 mask with a blur is what turns the
    // staircase edge into a soft one.
    const person = this.person.ctx
    person.imageSmoothingQuality = 'high'
    person.globalCompositeOperation = 'copy'
    person.filter = `blur(${Math.max(1, Math.round(width * FEATHER))}px)`
    person.drawImage(this.mask.canvas, 0, 0, width, height)
    person.filter = 'none'
    person.globalCompositeOperation = 'source-in'
    person.drawImage(frame, 0, 0, width, height)
    person.globalCompositeOperation = 'source-over'

    // Picture first, then you on top of it.
    this.out.ctx.drawImage(this.backdrop.canvas, 0, 0)
    this.out.ctx.drawImage(this.person.canvas, 0, 0)

    // Your own view: the same picture, with only you flipped across it.
    if (this.mirror) {
      const flipped = this.flipped.ctx
      flipped.drawImage(this.backdrop.canvas, 0, 0)
      flipped.setTransform(-1, 0, 0, 1, width, 0)
      flipped.drawImage(this.person.canvas, 0, 0)
      flipped.setTransform(1, 0, 0, 1, 0, 0)
    }

    this.markReady()
  }

  /** Run the model and turn its confidence into an alpha mask. */
  private segment(frame: VideoFrame): void {
    this.small.ctx.drawImage(frame, 0, 0, MASK_W, MASK_H)

    // VIDEO mode demands strictly increasing timestamps, and two frames can
    // land inside the same millisecond.
    this.lastTimestamp = Math.max(performance.now(), this.lastTimestamp + 1)
    const result = this.segmenter.segmentForVideo(this.small.canvas, this.lastTimestamp)
    try {
      const mask = result.confidenceMasks?.[0]
      if (!mask) throw new Error('no confidence mask')

      if (mask.width !== this.maskPixels.width || mask.height !== this.maskPixels.height) {
        this.mask.canvas.width = mask.width
        this.mask.canvas.height = mask.height
        this.maskPixels = this.mask.ctx.createImageData(mask.width, mask.height)
        this.maskPixels.data.fill(255)
      }

      const confidence = mask.getAsFloat32Array()
      const pixels = this.maskPixels.data
      const span = EDGE_HIGH - EDGE_LOW
      for (let i = 0, alpha = 3; i < confidence.length; i++, alpha += 4) {
        const t = Math.min(1, Math.max(0, (confidence[i] - EDGE_LOW) / span))
        pixels[alpha] = t * t * (3 - 2 * t) * 255
      }
      this.mask.ctx.putImageData(this.maskPixels, 0, 0)
    } finally {
      result.close()
    }
  }

  private markReady(): void {
    this.onFirstFrame?.()
    this.onFirstFrame = null
  }

  private resize(width: number, height: number): void {
    for (const surface of [this.person, this.backdrop, this.out, this.flipped]) {
      surface.canvas.width = width
      surface.canvas.height = height
    }
    this.paintBackdrop()
  }

  /**
   * The picture, scaled to cover the frame: cropped to fit, never stretched
   * and never letterboxed. Painted once per picture or frame size rather than
   * on every frame.
   */
  private paintBackdrop(): void {
    const { canvas, ctx } = this.backdrop
    const image = this.image
    if (!image.width || !image.height) return
    const scale = Math.max(canvas.width / image.width, canvas.height / image.height)
    const drawWidth = image.width * scale
    const drawHeight = image.height * scale
    ctx.drawImage(
      image,
      (canvas.width - drawWidth) / 2,
      (canvas.height - drawHeight) / 2,
      drawWidth,
      drawHeight
    )
  }
}

// --- the feed -------------------------------------------------------------

/** What to show in your own tile, and whether it still needs flipping. */
export interface SelfView {
  stream: MediaStream
  /** Apply the CSS mirror. False when the mirroring is already baked in. */
  flip: boolean
}

/**
 * A webcam, with or without a background.
 *
 * Owns the webcam stream. Publish `output`; after `setBackground` reports a
 * change, publish the new `output` in place of the old one and then call
 * `releaseRetired`. `close` releases everything.
 */
export class CameraFeed {
  private compositor: Compositor | null = null
  /** Every compositor still holding the GPU: the current one, and any retired
      one whose replacement is not on the air yet. */
  private readonly running = new Set<Compositor>()
  private passthrough: MediaStream | null = null
  /** Every clone ever handed out, in case one was never swapped out. */
  private readonly clones = new Set<MediaStreamTrack>()
  private wanted: string | null = null
  private starting: Promise<boolean> | null = null
  private closed = false

  constructor(
    /** The webcam. Never published: see the note at the top of this file. */
    private readonly source: MediaStream,
    private mirror: boolean
  ) {}

  /** The camera that produced this feed, for "is this still the right one". */
  get deviceId(): string | undefined {
    return this.source.getVideoTracks()[0]?.getSettings().deviceId
  }

  /** The stream to publish. Changes only when `setBackground` says so. */
  get output(): MediaStream {
    if (this.compositor) return this.compositor.output
    // A clone, not the webcam: the session will stop this when it swaps it
    // out, and the webcam has to survive that. Same source, no processing.
    if (!this.passthrough) {
      const tracks = this.source.getVideoTracks().map((t) => t.clone())
      tracks.forEach((t) => this.clones.add(t))
      this.passthrough = new MediaStream(tracks)
    }
    return this.passthrough
  }

  get selfView(): SelfView {
    if (this.compositor && this.mirror) {
      return { stream: this.compositor.mirrored, flip: false }
    }
    return { stream: this.output, flip: this.compositor ? false : this.mirror }
  }

  get backgroundOn(): boolean {
    return this.compositor !== null
  }

  /**
   * Turn the background on, change it, or turn it off — `null` is off.
   *
   * Resolves true when `output` changed and must be republished. Rejects only
   * when MediaPipe cannot start, and then the camera carries on without it.
   */
  async setBackground(url: string | null): Promise<boolean> {
    this.wanted = url
    // Whichever start is in flight reads `wanted` when it lands, so rapid
    // clicking while MediaPipe loads never starts two.
    if (this.starting) return this.starting
    if (this.closed) return false

    if (url === null) {
      if (!this.compositor) return false
      // Not closed here: its track is still on the air until the caller
      // publishes the replacement, then calls releaseRetired.
      this.compositor = null
      return true
    }

    if (this.compositor) {
      await this.compositor.setImage(url)
      return false
    }

    this.starting = this.start(url)
    try {
      return await this.starting
    } finally {
      this.starting = null
    }
  }

  /**
   * Close what `setBackground` replaced. Call once the new `output` is on the
   * air: before that, the old one is still what everyone is watching.
   */
  releaseRetired(): void {
    for (const compositor of [...this.running]) {
      if (compositor !== this.compositor) compositor.close()
    }
    const current = new Set(this.compositor ? [] : (this.passthrough?.getTracks() ?? []))
    for (const clone of [...this.clones]) {
      if (current.has(clone)) continue
      clone.stop()
      this.clones.delete(clone)
    }
  }

  setMirror(mirror: boolean): void {
    this.mirror = mirror
    for (const compositor of this.running) compositor.mirror = mirror
  }

  close(): void {
    this.closed = true
    for (const compositor of [...this.running]) compositor.close()
    this.compositor = null
    this.clones.forEach((t) => t.stop())
    this.clones.clear()
    this.passthrough = null
    this.source.getTracks().forEach((t) => t.stop())
  }

  private async start(url: string): Promise<boolean> {
    const track = this.source.getVideoTracks()[0]
    if (!track) return false

    const compositor = await Compositor.open(track, url, this.mirror, (c) =>
      this.running.delete(c)
    )
    // Bounded: a camera that never delivers a frame must not wedge every
    // later toggle behind this one.
    await Promise.race([compositor.ready, new Promise((r) => setTimeout(r, FIRST_FRAME_MS))])

    // Switched off, or the camera closed, while MediaPipe was loading.
    if (this.closed || this.wanted === null || compositor.isClosed) {
      compositor.close()
      return false
    }
    if (this.wanted !== url) await compositor.setImage(this.wanted)

    this.compositor = compositor
    this.running.add(compositor)
    // The clone that was on the air retires with releaseRetired.
    this.passthrough = null
    return true
  }
}
