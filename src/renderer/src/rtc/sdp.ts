/**
 * SDP and sender tuning, lifted straight from the TeamSpeak 6 teardown.
 *
 * Every value here has a citation in docs/teamspeak-rtc-teardown.md §4 — this
 * is the part of the investigation that turns into working settings rather
 * than prose.
 */

/**
 * Codec order by content, measured rather than assumed.
 *
 * The previous order led with AV1 on the theory that it is a large win on
 * screen content — flat regions, sharp text, repeated tiles. That is true of
 * AV1 the format and false of AV1 the software encoder available here: asked
 * for 1080p60 it collapsed to 480x270 at 1 frame per second. A codec that
 * cannot keep up does not compress better, it just arrives late. So AV1 goes
 * last everywhere until there is hardware behind it.
 *
 * Motion content leads with H.264, which has the broadest hardware support
 * and the cheapest software fallback. Detail content leads with VP9, which is
 * genuinely better on text at low bitrates and only has to manage 30 fps.
 */
const MOTION_CODEC_ORDER = ['video/H264', 'video/VP9', 'video/VP8', 'video/AV1']
const DETAIL_CODEC_ORDER = ['video/VP9', 'video/H264', 'video/VP8', 'video/AV1']

export type CodecContent = 'motion' | 'detail'

/**
 * Reorder a transceiver's codecs.
 *
 * The list MUST come from `RTCRtpReceiver.getCapabilities`, not the sender's.
 * This is not a stylistic preference — the sender list advertises H.264 High
 * (`profile-level-id=640032`), which the receiver does not accept, and
 * `setCodecPreferences` rejects the entire array over that one entry:
 *
 *     Invalid codec preferences: invalid codec with name "H264".
 *
 * It threw on every single call. Wrapped in a silent catch, that meant codec
 * preference had never once been applied in this app — every stream ran on
 * whatever order Chromium happened to default to, and no amount of reasoning
 * about AV1 made any difference to a single frame. Failures are logged now,
 * because a preference that quietly does nothing is worse than none at all.
 */
/**
 * Put Opus RED in front of plain Opus on a voice transceiver.
 *
 * Chromium already offers it — `a=rtpmap:63 red/48000/2` with
 * `a=fmtp:63 111/111` — and never uses it, because the m-line lists opus
 * first and the first payload wins. RED (RFC 2198) carries a copy of the
 * PREVIOUS packet inside the current one, so losing any single packet costs
 * nothing at all: the next one already contains it.
 *
 * That is the difference between a voice that survives a flaky link and one
 * that arrives in pieces. In-band FEC, which we already ask for, only helps
 * when the encoder decided to spend bits on it and the loss pattern suits
 * it; RED is unconditional.
 *
 * The price is roughly double the audio bitrate — 96 kbit/s becomes about
 * 190 — against a video stream measured in megabits. It is not a real
 * price.
 *
 * Only for voice. Screen audio is already stereo at 320k and doubling that
 * to protect a soundtrack is the wrong trade; a dropout in music is a
 * glitch, a dropout in speech is a word nobody heard.
 */
export function preferRed(transceiver: RTCRtpTransceiver): void {
  if (typeof RTCRtpReceiver.getCapabilities !== 'function') return
  const capabilities = RTCRtpReceiver.getCapabilities('audio')
  if (!capabilities) return

  const red = capabilities.codecs.filter((c) => c.mimeType.toLowerCase() === 'audio/red')
  if (red.length === 0) return

  try {
    transceiver.setCodecPreferences([
      ...red,
      ...capabilities.codecs.filter((c) => c.mimeType.toLowerCase() !== 'audio/red')
    ])
  } catch (error) {
    console.warn('[rtc] RED recusado:', (error as Error).message)
  }
}

/**
 * Tell Chromium this stream is the one that matters.
 *
 * Audio senders default to `networkPriority: 'low'` — measured, not assumed
 * — which is the same priority the screen share has while asking for twenty
 * megabits on the same transport. The allocator has no reason to protect
 * speech over pixels unless it is told.
 *
 * Honest about the size of this: the DSCP marking it also sets is mostly
 * inert on a home network with no QoS policy. The part that acts is
 * Chromium's own bitrate allocator, which reserves for high-priority
 * streams first. Cheap, sender-local, works against friends on any version.
 */
export async function prioritiseVoice(sender: RTCRtpSender): Promise<void> {
  const params = sender.getParameters()
  if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]
  for (const encoding of params.encodings) {
    encoding.priority = 'high'
    encoding.networkPriority = 'high'
  }
  try {
    await sender.setParameters(params)
  } catch (error) {
    console.warn('[rtc] prioridade de voz recusada:', (error as Error).message)
  }
}

export function preferCodecs(transceiver: RTCRtpTransceiver, content: CodecContent): void {
  if (typeof RTCRtpReceiver.getCapabilities !== 'function') return
  const capabilities = RTCRtpReceiver.getCapabilities('video')
  if (!capabilities) return

  const order = content === 'motion' ? MOTION_CODEC_ORDER : DETAIL_CODEC_ORDER
  const rank = (codec: RTCRtpCodec): number => {
    const index = order.indexOf(codec.mimeType)
    return index === -1 ? order.length : index
  }

  // Highest H.264 profile first within the H.264 group: more efficient at the
  // same bitrate, and every decoder that matters here handles it.
  const scored = [...capabilities.codecs].sort((a, b) => {
    const byMime = rank(a) - rank(b)
    if (byMime !== 0) return byMime
    const high = (c: RTCRtpCodec): number =>
      c.sdpFmtpLine?.includes('profile-level-id=640') ? 0 : 1
    return high(a) - high(b)
  })

  try {
    transceiver.setCodecPreferences(scored)
  } catch (error) {
    console.warn('[rtc] setCodecPreferences recusado:', (error as Error).message)
  }
}

export interface EncodingProfile {
  /** Bits per second ceiling for this track. */
  maxBitrate: number
  /** Divide the captured resolution by this before encoding. 1 keeps it. */
  scaleResolutionDownBy?: number
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

/**
 * Bitrate ceilings, sized for real home connections rather than for a lab.
 *
 * The first version of this file topped out at 10 Mbit/s and 60 fps, which is
 * what a LAN can carry. Over a TURN relay on a residential uplink it is pure
 * bufferbloat: the encoder fills the pipe, the queue grows, round-trip time
 * climbs into the tens of seconds, congestion control backs off, and the
 * whole cycle repeats — which is exactly the sawtooth stutter you feel.
 *
 * Brazilian home upload is commonly 5-35 Mbit/s, and in a mesh the publisher
 * pays for EVERY viewer. Three viewers at 4 Mbit/s is already 12 Mbit/s up.
 * These numbers leave headroom on purpose.
 */
/**
 * Per-stream ceilings.
 *
 * These are ceilings, not targets. What a stream actually gets is decided at
 * runtime by the upload governor in MeshSession, which starts low and raises
 * the budget only while measured round-trip time and loss stay healthy. That
 * is what makes a generous ceiling safe: the old static numbers had to be
 * timid, because nothing was watching and a number too high just drowned the
 * uplink — 19 seconds of buffer bloat, in the case that taught us this.
 *
 * Timid has its own cost, which is what a game stream looks like at 1.3
 * Mbit/s. With a governor in front, the ceiling can be what the content
 * deserves when the link can carry it.
 */
export const SCREEN_PROFILES = {
  /** Reading code or text. Detail over motion. */
  crisp: {
    maxBitrate: 6_000_000,
    maxFramerate: 30,
    scaleResolutionDownBy: 1,
    degradationPreference: 'maintain-resolution',
    contentHint: 'detail'
  },
  /** Games and video. Motion over detail. */
  smooth: {
    maxBitrate: 8_000_000,
    maxFramerate: 60,
    scaleResolutionDownBy: 1,
    degradationPreference: 'maintain-framerate',
    contentHint: 'motion'
  },
  /** A weak link, a full mesh, or anything going through a relay. */
  thrifty: {
    maxBitrate: 1_500_000,
    maxFramerate: 24,
    // 1080p becomes 720p. At a tight bitrate a smaller picture that is
    // actually sharp beats a large one made of blocks.
    scaleResolutionDownBy: 1.5,
    degradationPreference: 'maintain-resolution',
    contentHint: 'detail'
  }
} as const satisfies Record<string, EncodingProfile>

export type ScreenProfileName = keyof typeof SCREEN_PROFILES

/**
 * Capture ceiling for a given profile.
 *
 * Capping at the source matters more than capping the encoder: a 1440p60
 * capture squeezed into a few Mbit/s looks far worse than a 1080p capture at
 * the same bitrate, and burns more CPU to produce. 1080p is still plenty for
 * a shared screen, so the resolution ceiling does not move.
 *
 * The frame rate does. It used to ask for `ideal: 30` for everyone, including
 * the profile whose entire promise is 60 — Chromium honours `ideal`, so
 * "Fluido · 60 fps" captured 30 and no amount of bandwidth could fix it. A
 * game shared that way is halved before the encoder ever sees it.
 */
export function captureConstraints(profile: ScreenProfileName): MediaTrackConstraints {
  const fps = SCREEN_PROFILES[profile].maxFramerate
  return {
    width: { max: 1920 },
    height: { max: 1080 },
    frameRate: { ideal: fps, max: fps }
  }
}

export const CAMERA_PROFILE: EncodingProfile = {
  maxBitrate: 600_000,
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
    // The lever that makes the profiles differ at the SAME bitrate. Without
    // it, every profile sends 1080p and the only thing separating them is a
    // ceiling the bandwidth governor has usually already clamped to one
    // shared value — which is why switching quality appeared to do nothing.
    if (profile.scaleResolutionDownBy !== undefined) {
      encoding.scaleResolutionDownBy = profile.scaleResolutionDownBy
    }
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

/** What someone is SHOWING: music, a game, a video. Stereo earns its place. */
export const MEDIA_OPUS: OpusTuning = { stereo: true, maxAverageBitrate: 320_000, ptimeMs: 10 }

/**
 * A VOICE, which is one mouth and therefore mono.
 *
 * Mono is the obvious half. The half that was actually audible is the
 * bitrate. Until now the microphone section reached no tuning at all and ran
 * on Chromium's default of roughly 32 kbit/s, and that is where "a faint
 * hiss on my voice, like some spatial sound" comes from: below about 64
 * kbit/s Opus stops coding the top of the spectrum and fills it by folding
 * noise-shaped copies of the lower bands up into it. The result is a wash of
 * breath-coloured noise that moves WITH the voice, which is why it reads as
 * space around someone rather than as hiss on the line. No amount of noise
 * suppression touches it — it is added after capture, by the encoder.
 *
 * 96 kbit/s mono is far above where that folding starts, and against a video
 * stream measured in megabits it costs nothing worth counting.
 *
 * 20 ms packets rather than media's 10: in-band FEC carries a copy of the
 * previous frame inside the next one, and fewer, larger packets both make
 * that cheaper and halve the header overhead. On a voice that trade is worth
 * more than five milliseconds.
 *
 * Note which direction these travel. Per RFC 7587 `maxaveragebitrate` and
 * `stereo` describe what the SENDER OF THIS SDP wants to RECEIVE — they
 * instruct the far encoder, not ours. Our own microphone goes to 96k because
 * the other end is running this same code and asking us for it. The
 * `sprop-` pair is the half that describes us.
 */
export const VOICE_OPUS: OpusTuning = { stereo: false, maxAverageBitrate: 96_000, ptimeMs: 20 }

/** The fmtp body for one tuning. */
function opusFmtp(tuning: OpusTuning): string {
  const stereo = tuning.stereo ? 1 : 0
  return [
    `maxaveragebitrate=${tuning.maxAverageBitrate}`,
    'maxplaybackrate=48000',
    `minptime=${tuning.ptimeMs}`,
    'sprop-maxcapturerate=48000',
    `sprop-stereo=${stereo}`,
    `stereo=${stereo}`,
    'usedtx=0',
    'useinbandfec=1'
  ].join(';')
}

/**
 * Tune each audio section for what that section carries.
 *
 * There are two of them — the sound of a shared screen, and a microphone —
 * and they want opposite things, which is why there have always been two
 * tunings here. Only one was ever reaching the wire: the whole SDP was
 * treated as one string and the fmtp replacement was not global, so it
 * landed on the first audio section and stopped. Slots are created screen,
 * camera, screen audio, microphone, so the first audio section is the screen
 * and the microphone got nothing. VOICE_OPUS was defined, exported, and
 * referenced by no one.
 *
 * The `ptime` strip, meanwhile, WAS global, so the microphone section also
 * lost its packet size and never had one put back.
 *
 * Cutting at the m-lines first means each section is tuned by what it is,
 * and the result no longer depends on the order the transceivers happened to
 * be created in.
 */
export function tuneOpusBySection(
  sdp: string,
  media: OpusTuning,
  voice: OpusTuning,
  voiceMids: string[]
): string {
  const parts = sdp.split(/^(?=m=)/m)
  return parts
    .map((section) => {
      if (!section.startsWith('m=audio')) return section
      const mid = section.match(/^a=mid:(\S+)/im)?.[1] ?? ''
      return tuneOpus(section, voiceMids.includes(mid) ? voice : media)
    })
    .join('')
}

export function tuneOpus(sdp: string, tuning: OpusTuning): string {
  const payload = sdp.match(/^a=rtpmap:(\d+)\s+opus\/48000/im)?.[1]
  if (!payload) return sdp

  const desired = opusFmtp(tuning)

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
  media: OpusTuning,
  voice: OpusTuning = VOICE_OPUS,
  voiceMids: string[] = []
): RTCSessionDescriptionInit {
  if (!description.sdp) return description
  return {
    type: description.type,
    sdp: keepLatencyExtensions(
      tuneOpusBySection(description.sdp, media, voice, voiceMids)
    )
  }
}
