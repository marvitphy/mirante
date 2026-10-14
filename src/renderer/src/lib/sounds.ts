/**
 * Room sounds.
 *
 * Synthesised rather than shipped as files: four cues made of sine sweeps
 * cost a few hundred bytes of code instead of a few hundred kilobytes of
 * assets, and the timbre stays tunable in source.
 *
 * The brief is restraint. These fire while people are watching something —
 * a cue that demands attention is a cue that ruins the thing it interrupts.
 * So: short, soft, low in the mix, and pitched clear of speech so they cut
 * through a voice without fighting it.
 *
 * Direction of pitch carries the meaning. Up is arrival, down is departure;
 * nobody has to learn which sound is which.
 */

/** Well below interface-click loudness. These should register, not announce. */
const MASTER_GAIN = 0.1

let context: AudioContext | null = null
let muted = false

function ensureContext(): AudioContext | null {
  if (muted) return null
  if (!context) {
    try {
      context = new AudioContext({ latencyHint: 'interactive' })
    } catch {
      return null
    }
  }
  // Autoplay policy can leave it suspended until a gesture; resuming is cheap
  // and a cue that silently does not play is better than a thrown error.
  if (context.state === 'suspended') void context.resume()
  return context
}

interface Blip {
  /** Hertz at the start and end of the sweep. */
  from: number
  to: number
  /** Seconds from "now". */
  at: number
  duration: number
  gain?: number
}

function play(blips: Blip[]): void {
  const ctx = ensureContext()
  if (!ctx) return
  const now = ctx.currentTime

  for (const blip of blips) {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'

    const start = now + blip.at
    const end = start + blip.duration

    osc.frequency.setValueAtTime(blip.from, start)
    // Exponential matches how pitch is heard; a linear ramp sounds like it
    // slows down at the top.
    osc.frequency.exponentialRampToValueAtTime(blip.to, end)

    const peak = MASTER_GAIN * (blip.gain ?? 1)
    gain.gain.setValueAtTime(0.0001, start)
    // 12 ms attack: fast enough to feel instant, slow enough not to click.
    gain.gain.exponentialRampToValueAtTime(peak, start + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, end)

    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(start)
    osc.stop(end + 0.02)
  }
}

/** Someone joined the room. Two rising blips — a bubble surfacing. */
export function soundJoin(): void {
  play([
    { from: 520, to: 780, at: 0, duration: 0.09 },
    { from: 780, to: 1180, at: 0.075, duration: 0.11, gain: 0.8 }
  ])
}

/** Someone left. The same gesture inverted. */
export function soundLeave(): void {
  play([
    { from: 760, to: 520, at: 0, duration: 0.1 },
    { from: 500, to: 320, at: 0.085, duration: 0.14, gain: 0.75 }
  ])
}

/** A broadcast started. Longer and warmer — something is beginning. */
export function soundLiveStart(): void {
  play([
    { from: 392, to: 392, at: 0, duration: 0.12, gain: 0.7 },
    { from: 587, to: 587, at: 0.1, duration: 0.14, gain: 0.85 },
    { from: 784, to: 784, at: 0.21, duration: 0.22, gain: 0.6 }
  ])
}

/** A broadcast ended. The same three notes, walked back down. */
export function soundLiveEnd(): void {
  play([
    { from: 784, to: 784, at: 0, duration: 0.1, gain: 0.6 },
    { from: 587, to: 587, at: 0.09, duration: 0.12, gain: 0.75 },
    { from: 392, to: 392, at: 0.19, duration: 0.24, gain: 0.55 }
  ])
}

export function setSoundsMuted(value: boolean): void {
  muted = value
}

export function soundsMuted(): boolean {
  return muted
}
