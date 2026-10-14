/**
 * SDP and sender tuning, lifted straight from the TeamSpeak 6 teardown.
 *
 * Every value here has a citation in docs/teamspeak-rtc-teardown.md §4 — this
 * is the part of the investigation that turns into working settings rather
 * than prose.
 */

/** Codec order we prefer for screen content. */
const SCREEN_CODEC_ORDER = ['video/AV1', 'video/VP9', 'video/H264', 'video/VP8']
/** Camera is small and moves a lot; H.264 hardware paths are the safest bet. */
const CAMERA_CODEC_ORDER = ['video/H264', 'video/VP9', 'video/AV1', 'video/VP8']

/**
 * Reorder a transceiver's codecs.
 *
 * TeamSpeak offers AV1 ahead of VP8 and uses H.264 High profile (`640c1f`)
 * rather than the Constrained Baseline browsers default to. AV1 is a large win
 * specifically on screen content — flat regions, sharp text, repeated tiles.
 */
export function preferCodecs(transceiver: RTCRtpTransceiver, kind: 'screen' | 'camera'): void {
  if (typeof RTCRtpSender.getCapabilities !== 'function') return
  const capabilities = RTCRtpSender.getCapabilities('video')
  if (!capabilities) return

  const order = kind === 'screen' ? SCREEN_CODEC_ORDER : CAMERA_CODEC_ORDER
  const rank = (codec: RTCRtpCodec): number => {
    const index = order.indexOf(codec.mimeType)
    return index === -1 ? order.length : index
  }

  // H.264 High profile first within the H.264 group, mirroring TeamSpeak's
  // `profile-level-id=640c1f` offer.
  const scored = [...capabilities.codecs].sort((a, b) => {
    const byMime = rank(a) - rank(b)
    if (byMime !== 0) return byMime
    const high = (c: RTCRtpCodec): number =>
      c.sdpFmtpLine?.includes('profile-level-id=640') ? 0 : 1
    return high(a) - high(b)
  })

  try {
    transceiver.setCodecPreferences(scored)
  } catch {
    // Older engines reject unknown codecs wholesale; the default order is fine.
  }
}

export interface EncodingProfile {
  /** Bits per second ceiling for this track. */
  maxBitrate: number
  maxFramerate?: number
  /**
   * What the encoder should assume it is looking at.
   *
   * This MUST agree with `degradationPreference`. `detail` makes Chromium
   * favour resolution and tolerate a low frame rate; `motion` does the
   * opposite. Pairing `detail` with `maintain-framerate` gives the encoder two
   * contradictory instructions and the hint tends to win, which is how a
   * "smooth" profile ends up behaving like a text-optimised one.
   */
  contentHint: 'detail' | 'motion'
  /**
   * `maintain-resolution` keeps text sharp and drops frames under congestion —
   * the screen-share behaviour TeamSpeak gets from `screenshare_layers.cc`.
   * `maintain-framerate` is right for camera, where motion matters more than
   * detail.
   */
  degradationPreference: RTCDegradationPreference
}

export const SCREEN_PROFILES = {
  /** Reading code or text. Detail over motion. */
  crisp: {
    maxBitrate: 8_000_000,
    maxFramerate: 30,
    degradationPreference: 'maintain-resolution',
    contentHint: 'detail'
  },
  /** Games and video. Motion over detail. */
  smooth: {
    maxBitrate: 10_000_000,
    maxFramerate: 60,
    degradationPreference: 'maintain-framerate',
    contentHint: 'motion'
  },
  /** Someone on a weak link, or a full mesh. Stays on `detail` on purpose:
      when bandwidth is scarce, readable text beats smooth motion. */
  thrifty: {
    maxBitrate: 2_500_000,
    maxFramerate: 30,
    degradationPreference: 'maintain-resolution',
    contentHint: 'detail'
  }
} as const satisfies Record<string, EncodingProfile>

export type ScreenProfileName = keyof typeof SCREEN_PROFILES

export const CAMERA_PROFILE: EncodingProfile = {
  maxBitrate: 1_200_000,
  maxFramerate: 30,
  degradationPreference: 'maintain-framerate',
  contentHint: 'motion'
}

/**
 * Apply an encoding profile to a live sender. Safe to call repeatedly.
 *
 * Sets the content hint as well as the parameters, so switching profile
 * mid-session actually changes how the encoder behaves. Setting only
 * `setParameters` leaves a stale hint behind, which then contradicts the new
 * degradation preference.
 */
export async function applyProfile(
  sender: RTCRtpSender,
  profile: EncodingProfile
): Promise<void> {
  if (sender.track && 'contentHint' in sender.track) {
    sender.track.contentHint = profile.contentHint
  }

  const params = sender.getParameters()
  if (!params.encodings || params.encodings.length === 0) {
    params.encodings = [{}]
  }
  for (const encoding of params.encodings) {
    encoding.maxBitrate = profile.maxBitrate
    if (profile.maxFramerate !== undefined) encoding.maxFramerate = profile.maxFramerate
  }
  params.degradationPreference = profile.degradationPreference
  try {
    await sender.setParameters(params)
  } catch (error) {
    console.warn('[sdp] setParameters rejected:', error)
  }
}

/**
 * Tell the encoder what kind of content it is looking at, before any sender
 * exists. Chromium uses this to pick its rate controller — the same decision
 * TeamSpeak signals over the wire with the `video-content-type` RTP header
 * extension.
 *
 * Once a sender exists, `applyProfile` owns the hint so it can never drift
 * out of step with the degradation preference.
 */
export function setContentHint(track: MediaStreamTrack, hint: 'detail' | 'motion'): void {
  if ('contentHint' in track) track.contentHint = hint
}

// ---------------------------------------------------------------------------
// SDP munging
// ---------------------------------------------------------------------------

/**
 * Opus parameters taken verbatim from TeamSpeak's captured offer:
 *
 *   a=fmtp:111 maxaveragebitrate=320000;stereo=1;sprop-stereo=1;
 *              useinbandfec=1;usedtx=0;minptime=10
 *   a=ptime:10
 *
 * The two that matter:
 *   - `ptime:10` — 10 ms frames instead of the browser's 20 ms. Halves
 *     packetization delay at the cost of roughly double header overhead. A
 *     deliberate trade of bandwidth for latency.
 *   - `stereo=1` at 320 kbps — this carries game and media audio, not speech,
 *     so it is tuned like music, not like a phone call.
 *   - `usedtx=0` — discontinuous transmission off. DTX saves bytes in silence
 *     but adds attack transients, which is wrong for media.
 */
export interface OpusTuning {
  stereo: boolean
  maxAverageBitrate: number
  ptimeMs: number
}

export const MEDIA_OPUS: OpusTuning = { stereo: true, maxAverageBitrate: 320_000, ptimeMs: 10 }
export const VOICE_OPUS: OpusTuning = { stereo: false, maxAverageBitrate: 64_000, ptimeMs: 20 }

export function tuneOpus(sdp: string, tuning: OpusTuning): string {
  const payload = sdp.match(/^a=rtpmap:(\d+)\s+opus\/48000/im)?.[1]
  if (!payload) return sdp

  const stereo = tuning.stereo ? 1 : 0
  const desired = [
    `maxaveragebitrate=${tuning.maxAverageBitrate}`,
    'maxplaybackrate=48000',
    `minptime=${tuning.ptimeMs}`,
    'sprop-maxcapturerate=48000',
    `sprop-stereo=${stereo}`,
    `stereo=${stereo}`,
    'usedtx=0',
    'useinbandfec=1'
  ].join(';')

  const fmtpLine = new RegExp(`^a=fmtp:${payload} .*$`, 'im')
  let out = fmtpLine.test(sdp)
    ? sdp.replace(fmtpLine, `a=fmtp:${payload} ${desired}`)
    : sdp.replace(
        new RegExp(`^(a=rtpmap:${payload}\\s+opus/48000.*)$`, 'im'),
        `$1\r\na=fmtp:${payload} ${desired}`
      )

  // One ptime per audio m-section.
  out = out.replace(/^a=ptime:\d+\r?\n/gim, '')
  out = out.replace(
    new RegExp(`^(a=fmtp:${payload} .*)$`, 'im'),
    `$1\r\na=ptime:${tuning.ptimeMs}`
  )
  return out
}

/**
 * Hint the receiver's jitter buffer via the `playout-delay` extension.
 *
 * TeamSpeak negotiates `extmap:5 .../playout-delay` and most WebRTC apps never
 * touch it. min=0 means "show me frames as soon as they arrive" — the explicit
 * latency-versus-smoothness dial. Chromium reads this from the SDP direction of
 * travel; we only ensure the extension survives into the answer.
 */
export function keepLatencyExtensions(sdp: string): string {
  // Chromium already offers these; strip nothing. Present as a named operation
  // so the intent is greppable rather than implicit in an absence of code.
  return sdp
}

export function applyAudioTuning(
  description: RTCSessionDescriptionInit,
  tuning: OpusTuning
): RTCSessionDescriptionInit {
  if (!description.sdp) return description
  return { type: description.type, sdp: keepLatencyExtensions(tuneOpus(description.sdp, tuning)) }
}
