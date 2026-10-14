# TeamSpeak 6 — Real-Time A/V Teardown

Evidence-based reverse engineering of the TeamSpeak client installed on this machine.
Goal: understand P2P, screen sharing, latency, bandwidth and quality mechanics worth reusing.

**Date:** 2026-10-14
**Analyst note on methodology — read this before trusting anything below.**

REA was used, but in degraded mode. Two blockers, both reported rather than worked around:

1. The `rea` **MCP server failed to connect** this session: `CONNECT_TIMEOUT after 30000ms`.
2. Fell back to the local **`rea` CLI v6.4.0** via the `reverse-engineer-anything` skill.
   `rea doctor` found Ghidra 12.1.4 installed at `C:\tools\ghidra_12.1.4_PUBLIC`, but
   `rea inspect` on `TeamSpeak.dll` returned:

   ```
   code: provider_unavailable
   rejections[0]: { provider_id: "ghidra", code: "unsupported_version",
                    reason: "Update JAVA_HOME to the root of a 64-bit full JDK 21 or newer installation." }
   ```

   This host has only `JAVA_HOME=C:\Program Files\Eclipse Adoptium\jdk-17.0.18.8-hotspot`
   (OpenJDK 17.0.18). Ghidra 12.x requires JDK 21+. **No decompilation was performed.**
   Installing a JDK was out of scope without asking.

So the findings below come from **static artifact evidence, not decompiled pseudocode**:
filesystem inspection, 18 sessions of client logs (including full captured SDP and ICE
exchanges), and 112 370 extracted strings from `TeamSpeak.dll` including MSVC-mangled C++
symbols, which give exact class and template names.

That is sufficient for everything claimed here — protocol, topology, codecs, capture
backends and class architecture are all directly observable — but it means no claim about
*control flow inside a function* is made anywhere in this document. Install a JDK 21+ and
re-run `rea inspect` if that depth is ever needed.

Every claim below is tied to a quoted artifact.

> **Redaction note.** This report was produced from live client logs on the
> author's machine. Public IP addresses, the residential IPv6 prefix, a private
> TeamSpeak server's hostname, and the Matrix user IDs of the people who were in
> the call have been replaced with placeholders. Everything structural — SDP
> bodies, candidate types and priorities, codec parameters, header extensions,
> symbol names — is verbatim, because that is what the findings rest on.
> Session credentials that do appear (ICE ufrag/pwd, DTLS fingerprints) are
> ephemeral and expired with the sessions that produced them.


---

## 1. Target identity

| Fact | Value | Evidence |
|---|---|---|
| Install root | `%LOCALAPPDATA%\Programs\TeamSpeak` | directory listing, 502 MB |
| Branded version | `ProductVersion=5.0.0` | `crash_reporter.cfg` |
| **Actual build** | **`TeamSpeak Client 6.0.0-beta4.1 (2026-05-27 11:14:35)`** | `ts5client_2026-10-14_00-42.log:3` |
| Host | `Windows 11 (22631) x64 ... Binary: 64bit` | same log line 4 |

Note the mismatch: the packaging still says 5.0.0, the running client reports 6.0.0-beta4.1.
Trust the log line.

### Shipped binaries (what they tell us)

```
TeamSpeak.exe                     3.2M   thin launcher
TeamSpeak.dll                    46.4M   ← the whole native core (libwebrtc statically linked)
libcef.dll                      252.6M   Chromium Embedded Framework — the UI is a web app
libtschat_client_lib.dll          76.9K   \ Matrix chat client
libtschat_client_lib_export.dll  17.2M   /
olm.dll                          318.2K   Olm/Megolm — Matrix end-to-end encryption
avcodec-62.dll / avformat / avutil / avfilter / swscale / swresample   FFmpeg
d3dcompiler_47.dll, dxcompiler.dll, libGLESv2.dll, vk_swiftshader.dll  GPU / render
hotkey_helper.exe, patcher.exe
```

Three-layer architecture, immediately readable from the file list:

1. **CEF (Chromium) renderer** — the entire UI is HTML/JS. Confirmed by
   `html/client_ui/` containing hashed webpack assets (`0108e89c9003e8c14ea3.woff`,
   `44309235e24898ac5d89.png`, …) and `locales/{de,en,es,es_MX,fr,pl,pt_BR,ru,zh_Hans}.json`.
2. **TeamSpeak.dll native core** — audio engine, video engine, WebRTC stack, TS3 voice protocol.
3. **Matrix** (`libtschat_*` + `olm.dll`) — chat *and*, critically, **A/V signaling transport**.

---

## 2. The headline: TWO different transports, not one

This is the single most important structural finding, and it is easy to get wrong.

### 2a. Voice chat = classic client–server, proprietary UDP. NOT P2P.

```
[info] Connecting to <ts-server-ipv4>:9987
[info] Connecting to resolved address <ts-server-ipv4>
[info] server sent ciphers:35
```
— `ts5client_2026-10-06_20-33.log:14-16`

Port `9987/UDP` is the TeamSpeak 3 voice protocol. `server sent ciphers:35` is the TS
handshake, not DTLS. Server discovery uses TeamSpeak's own DNS scheme before plain A/AAAA:

```
[info] SRV DNS resolve unsuccessful, "_ts3._udp.ts.example-server.net" DNS server returned answer with no data
[info] SRV DNS resolve unsuccessful, "_tsdns._tcp.example-server.net" ...
[info] A/AAAA DNS resolve successful, "ts.example-server.net" =(h: <ipv6-prefix>::f630:848d p:0), (h: <ts-server-ipv4> p:0)
[info] TSDNS queried unsuccessfully <ts-server-ipv4>:41144
```

Resolution order, confirmed: `_ts3._udp` SRV → `_tsdns._tcp` SRV → TSDNS on `:41144` → A/AAAA
→ default `:9987`. Implemented with Boost.Asio (`Resolver@tsdns@teamspeak@com`,
`async_resolve_a_and_aaaa`, mangled symbols in `TeamSpeak.dll`).

**Why server-based voice is the right call:** an N-person voice mix on a mesh costs every
client N upstreams and N decodes continuously, because people talk over each other. A server
can mix, apply a single jitter budget, and keep per-client upstream at 1×. Voice is the
always-on stream; video is the occasional one. TeamSpeak optimised each separately.

### 2b. Video + screen share = WebRTC, peer-to-peer mesh.

Completely separate stack. Full standard WebRTC: SDP offer/answer, trickle ICE, DTLS-SRTP,
BUNDLE, rtcp-mux.

```
[info] SessionOutbound::ResolveJoinRequest - adding viewer to stream:
{"chatId":1,"id":"mNs1Iuut","otherDeviceId":"HKKLKCDBYC",
 "otherUserId":"@<redacted-user>:chat-9.tmspk.net",
 "roomId":"!dPUjqqQQobySGFhNUR:chat-2.tmspk.net",
 "userId":"@<redacted-user>:chat-2.tmspk.net"}
```

That record proves three things at once:

- **It is a mesh.** `ResolveJoinRequest - adding viewer to stream` fires once *per viewer*,
  and each produces its own `offer` with its own `ice-ufrag` / `ice-pwd` / DTLS fingerprint.
  One broadcaster → N independent `RTCPeerConnection`s.
- **Signaling rides on Matrix.** `roomId: !…:chat-2.tmspk.net`, `userId: @…:chat-N.tmspk.net`
  is Matrix addressing verbatim. `otherDeviceId` is a Matrix device ID. With `olm.dll` present,
  the signaling (and therefore the SDP and ICE candidates) is **end-to-end encrypted** by
  Olm/Megolm — TeamSpeak's own servers cannot read the session descriptions.
- Users are sharded across chat homeservers (`chat-2`, `chat-7`, `chat-9`) and federate.

---

## 3. The signaling protocol — 5 verbs, that's it

Counted across all client logs:

```
    547  "cmd":"iceCandidate"
     71  "cmd":"answer"
     51  "cmd":"offer"
     22  "cmd":"joinResponse"
      1  "cmd":"reconnectOffer"
```

Carried as Matrix room events: `OnStreamSignalingMessage from <local-id> to <peer-uuid>`.

The whole protocol:

| verb | direction | meaning |
|---|---|---|
| `joinResponse` | broadcaster → viewer | `{"decision":true,"offer":"<SDP>"}` — admission control **and** the offer in one message |
| `offer` | broadcaster → viewer | full SDP with pre-gathered candidates inline |
| `answer` | viewer → broadcaster | SDP answer |
| `iceCandidate` | both | `{"mLine":0,"mid":"0","sdp":"candidate:…"}` trickle |
| `reconnectOffer` | broadcaster → viewer | ICE/stream resume without tearing down the session |

Two details worth stealing:

- **`joinResponse` fuses authorization and the offer.** One round trip instead of
  "may I join?" → "yes" → "here is my offer". Saves a full RTT on a path that is already
  federated across two Matrix homeservers.
- **`reconnectOffer` exists as a distinct verb** — a first-class resume path, not a
  teardown-and-rejoin. The matching native symbol is `StreamBase::Reconnect`, and it fired
  in the logs (`2 StreamBase::Reconnect`).

---

## 4. The SDP, line by line — this is the tuning sheet

Captured offer (broadcaster side, screen share session), from
`ts5client_2026-10-06_20-33.log`:

### 4a. Video m-line

```
m=video 57317 UDP/TLS/RTP/SAVPF 103 107 98 39 96 97 104 108 40 99 117 118 119
a=group:BUNDLE 0 1
a=rtcp-mux
a=rtcp-rsize
a=sendonly
a=ice-options:trickle
a=setup:actpass
a=fingerprint:sha-256 14:D3:27:0D:…
```

Codec offer order and parameters:

```
a=rtpmap:103 H264/90000   a=fmtp:103 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c1f
a=rtpmap:107 H264/90000   a=fmtp:107 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=640c1f
a=rtpmap:98  VP9/90000    a=fmtp:98  profile-id=0
a=rtpmap:39  AV1/90000    a=fmtp:39  level-idx=5;profile=0;tier=0
a=rtpmap:96  VP8/90000
a=rtpmap:117 red/90000
a=rtpmap:119 ulpfec/90000
a=rtpmap:{97,104,108,40,99,118} rtx/90000   (apt= 96,103,107,39,98,117)
a=ssrc-group:FID 3069921656 4137774188
```

Read that carefully:

- **H.264 High profile, level 3.1** (`640c1f`) first — not the Constrained Baseline `42e01f`
  that browsers default to. High profile gives CABAC and 8×8 transform: materially better
  quality at the same bitrate, which matters most for text on a shared screen.
- **AV1 is offered** (`a=rtpmap:39 AV1/90000`). For screen content AV1 is dramatically more
  efficient than H.264 — screen content is exactly the case where its tools win.
- **Both H.264 packetization modes** (1 = non-interleaved/aggregated, 0 = single NAL) for
  decoder compatibility.
- **RTX on every payload type** (`apt=` for all five codecs) — retransmission, the primary
  loss-recovery mechanism, preferred over FEC because it costs nothing when the link is clean.
- **ULPFEC + RED** available as the *secondary* recovery layer for when RTT is too long for
  RTX to help.
- `a=ssrc-group:FID` ties the media SSRC to its RTX SSRC.

Header extensions — this is where the latency engineering lives:

```
a=extmap:1  urn:ietf:params:rtp-hdrext:toffset
a=extmap:2  http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time
a=extmap:3  urn:3gpp:video-orientation
a=extmap:4  http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01
a=extmap:5  http://www.webrtc.org/experiments/rtp-hdrext/playout-delay
a=extmap:6  http://www.webrtc.org/experiments/rtp-hdrext/video-content-type
a=extmap:7  http://www.webrtc.org/experiments/rtp-hdrext/video-timing
a=extmap:8  http://www.webrtc.org/experiments/rtp-hdrext/color-space
a=extmap:{9,10,11} sdes:mid / sdes:rtp-stream-id / sdes:repaired-rtp-stream-id
```

- **`transport-cc` (extmap:4) + `goog-remb`** on every codec — send-side bandwidth estimation.
  Backed by `modules/congestion_controller/goog_cc/send_side_bandwidth_estimation.cc` and
  `modules/pacing/bitrate_prober.cc` in the binary. The receiver reports arrival times, the
  *sender* computes the estimate. REMB is kept only as legacy fallback.
- **`playout-delay` (extmap:5)** — the sender tells the receiver how much to buffer.
  Set min=0 for "interactive, show me frames now"; raise it for smooth playback. This is the
  explicit latency-vs-smoothness dial, and most WebRTC apps never touch it.
- **`video-content-type` (extmap:6)** — flags the stream as screen content, which switches
  the receiver's jitter buffer and the sender's rate control to screen-share behaviour.
- **`video-timing` (extmap:7)** — per-frame capture/encode/pacer timestamps, i.e. an
  end-to-end latency breakdown measurable in production.
- **`rtp-stream-id` / `repaired-rtp-stream-id` (extmap:10/11)** — the simulcast RID plumbing.
- Feedback set per codec: `nack`, `nack pli`, `ccm fir`, `transport-cc`, `goog-remb`.

### 4b. Audio m-line

```
m=audio 57326 UDP/TLS/RTP/SAVPF 111
a=rtpmap:111 opus/48000/2
a=fmtp:111 maxaveragebitrate=320000;maxplaybackrate=48000;minptime=10;
           sprop-maxcapturerate=48000;sprop-stereo=1;stereo=1;usedtx=0;useinbandfec=1
a=ptime:10
a=extmap:14 urn:ietf:params:rtp-hdrext:ssrc-audio-level
a=rtcp-fb:111 transport-cc
```

- **`ptime:10` — 10 ms frames.** Browser default is 20 ms. Halving the frame size halves
  packetization delay at the cost of ~2× header overhead. This is a deliberate latency buy.
- **`maxaveragebitrate=320000` and `stereo=1`** — 320 kbps stereo Opus at 48 kHz full band.
  Media-grade, not voice-grade. This audio m-line belongs to the *screen share* (`msid:
  outgoing_video`), so it is for sharing game/application audio in stereo — not for speech.
- **`useinbandfec=1`** — Opus carries a low-bitrate copy of the previous frame, so a single
  lost packet is concealed without a retransmit.
- **`usedtx=0`** — discontinuous transmission *off*. DTX saves bandwidth during silence but
  introduces attack transients; for shared media audio, constant rate is correct.

### 4c. ICE

Nine host candidates per m-line — every interface on the machine, UDP first:

```
a=candidate:4127935014 1 udp 2122194687 100.123.142.72 57317 typ host ... network-id 3 network-cost 50
a=candidate:3688471262 1 udp 2121867007 26.58.168.83   57318 typ host ... network-id 1
a=candidate:3308226919 1 udp 2121801471 192.168.100.46 57319 typ host ... network-id 5
a=candidate:4145766938 1 udp 2121735935 172.21.112.1   57320 typ host ... network-id 11
a=candidate:2882175294 1 udp 2122265343 fd7a:115c:a1e0::903a:8e49 57321 typ host ... network-cost 50
… IPv6 host candidates …
```

Then, trickled later, the reflexive and TCP candidates:

```
candidate:1407709118 1 udp 1685593855 <public-ipv4> 55270 typ srflx raddr 192.168.100.46 rport 57319
candidate:144809650  1 tcp 1518214911 100.123.142.72 63960 typ host tcptype passive
candidate:998596083  1 tcp 1517821695 192.168.100.46 63962 typ host tcptype passive
```

- **IPv6 is a first-class path**, offered at equal or higher priority than IPv4.
- **`network-cost 50`** is applied to the Tailscale (`100.123.142.72`, `fd7a:115c:a1e0::/48`)
  and cellular-looking interfaces — ICE deprioritises metered/overlay links automatically.
- **srflx candidates prove STUN is in use** (public `<public-ipv4>` discovered behind
  `192.168.100.46`).
- **TCP passive host candidates** are offered as the last-resort path for UDP-blocked networks.

> **Bounded negative result:** across every logged session on this machine, **no `typ relay`
> candidate appears**, and no `turn:` URI appears in `TeamSpeak.dll`'s extracted strings
> (112 370 strings scanned). STUN is confirmed; TURN is *not observed*. This does **not**
> prove TeamSpeak ships no TURN — credentials could arrive over the encrypted Matrix
> signaling channel and never be logged. But on the evidence available, the fallback ladder
> observed is: **UDP host → UDP srflx → TCP host.** If that is the real ladder, symmetric-NAT
> and strict-corporate-firewall pairs simply fail to connect. **This is the clearest gap to
> fix in our own build.**

---

## 5. Inside TeamSpeak.dll — the native engine

### 5a. It is upstream libwebrtc, statically linked

Build paths survive in the binary (`..\..\2e8b64\1\src\...` is a Conan build root):

```
src\media\engine\webrtc_video_engine.cc
src\media\engine\webrtc_voice_engine.cc
src\pc\webrtc_sdp.cc
src\pc\webrtc_session_description_factory.cc
src\modules\congestion_controller\goog_cc\send_side_bandwidth_estimation.cc
src\modules\pacing\bitrate_prober.cc
src\modules\rtp_rtcp\source\flexfec_03_header_reader_writer.cc
src\modules\rtp_rtcp\source\flexfec_{sender,receiver}.cc
src\modules\rtp_rtcp\source\ulpfec_{generator,header_reader_writer}.cc
src\modules\video_coding\codecs\vp8\screenshare_layers.cc
src\modules\video_coding\codecs\vp8\libvpx_vp8_encoder.cc
src\modules\video_coding\codecs\vp9\libvpx_vp9_encoder.cc
src\modules\video_coding\codecs\av1\libaom_av1_encoder.cc
src\modules\video_coding\svc\scalability_mode_util.cc
src\modules\video_coding\svc\simulcast_to_svc_converter.cc
src\modules\video_coding\utility\simulcast_rate_allocator.cc
src\modules\desktop_capture\win\screen_capturer_win_gdi.cc
src\third_party\opus\src\{celt,silk}\*.c
```

Plus the field-trial registry, including `WebRTC-BweWindowSizeInPackets`,
`WebRTC-AddPacingToCongestionWindowPushback`, `WebRTC-AV1-OverridePriorityBitrate`,
`WebRTC-AddNetworkCostToVpn`, and ~60 `WebRTC-Aec3*` echo-canceller tuning switches.

**`simulcast_to_svc_converter.cc` and `screenshare_layers.cc` being linked in is the proof
that layered encoding is live**, not vestigial — `screenshare_layers.cc` is VP8's
screen-content temporal-layer rate controller specifically.

### 5b. TeamSpeak's own video layer (C++ class inventory from mangled symbols)

Demangled from `TeamSpeak.dll` — namespace `com::teamspeak::video`:

**Topology**
```
StreamBase
  StreamP2P                      ← peer-to-peer mesh
  StreamSFU                      ← selective forwarding unit
SessionBase / SessionInbound / SessionOutbound / SessionSubscriberManager
I_Connection_Video
```
**Both topologies are implemented.** The logs on this machine only exercised `StreamP2P`
(per-viewer offers, direct host candidates). `StreamSFU` exists for the case where mesh does
not scale. Design lesson: build the *abstraction* (`StreamBase`) first, pick the topology at
runtime.

**Shared encoding — the most valuable idea in the whole binary**
```
com::teamspeak::video::codec::TeamSpeakSharedVideoEncoderFactory
com::teamspeak::video::codec::TeamSpeakSFUEncoderBroadcaster
com::teamspeak::video::codec::TeamSpeakSFUEncoderReceiver
com::teamspeak::video::ScalableSharedVideoTransformer
com::teamspeak::video::ScalableVideoSourceInterface
com::teamspeak::video::ScalableVideoTransformerInterface
```
The naive mesh is quadratic in the wrong place: N `RTCPeerConnection`s means N video
encoders running on the same source frames. For a 1440p screen share at 60 fps that is
ruinous. TeamSpeak inserts a **broadcaster/receiver pair around one encoder instance**:
encode the frame once, hand the same encoded bitstream to every peer connection. CPU cost
becomes O(1) in viewers instead of O(N); only packetization and pacing stay per-peer.

**Codec layer — custom factory injected into libwebrtc**
```
InternalTeamSpeakEncoderFactory  /  InternalDecoderFactory  /  VideoEncoderFactory
FFmpegCodecManager
FFmpegEncoderBase → FFmpegEncoderH264 / FFmpegEncoderVP8 / FFmpegEncoderVP9 / FFmpegEncoderAV1
FFmpegDecoderBase → FFmpegDecoderH264 / FFmpegDecoderVP8 / FFmpegDecoderVP9 / FFmpegDecoderAV1
H264EncoderImpl / H264DecoderImpl
EncoderWithMixin<FFmpegEncoderH264, NVEncMixin<FFmpegEncoderH264>>
EncoderWithMixin<FFmpegEncoderAV1,  NVEncMixin<FFmpegEncoderAV1>>
create_encoder_factory_and_options_functions<...>
create_extra_settings_encoder_factory_and_options_functions<..., webrtc::H264EncoderSettings>
```
They replaced libwebrtc's built-in encoder factory with their own FFmpeg-backed one, then
layered `NVEncMixin` (NVIDIA NVENC) on top via CRTP. That is why the shipped FFmpeg DLLs are
there, and it is how they get **hardware AV1 encode**, which stock libwebrtc does not provide.

Runtime hardware probing, observed:
```
[warning] HW probe: QSV blocked -- Intel VPL dispatcher library not available
[warning] HW probe: AMF blocked -- AMF runtime library not available
          (AMF driver probe failed) / (driver probe failed)
          "does not support HW frames context or device context, skipping"
```
Three vendor backends probed at startup — **QSV** (Intel), **AMF** (AMD), **NVENC** (NVIDIA) —
each degrading silently to software. Note `openh264.dll` is fetched and verified at runtime
rather than shipped (`Writing signed openh264 binary to disk: …\Cache\Default\openh264.dll`),
the standard Cisco-licensing manoeuvre.

**Capture backends — three, with fallback**
```
webrtc::WgcCaptureSession + Windows::Graphics::Capture::GraphicsCaptureItem   ← WGC (Win10 1803+)
webrtc::DxgiDesktopFrame, webrtc::DxgiTexture                                 ← DXGI Desktop Duplication
screen_capturer_win_gdi.cc                                                     ← GDI (last resort)
com::teamspeak::video::DesktopCapturer / ScreenshareManager
com::teamspeak::video::DesktopAndCursorComposer / DesktopFrameWithCursor
com::teamspeak::video::CameraCapturer / CaptureBase / CapturerTrackSource / CaptureSinkInterface
com::teamspeak::video::ThumbnailCapturer
```
WGC is the modern path (GPU-resident, per-window, handles occlusion and HDR); DXGI Desktop
Duplication is the full-screen GPU path; GDI is the CPU fallback. `DesktopAndCursorComposer`
composites the cursor separately — the cursor moves far more often than the screen content,
so compositing it late avoids forcing a full-frame update on every mouse twitch.
`ThumbnailCapturer` is the live preview in the source picker.

**Audio capture, A/V sync, zero-copy buffers**
```
AudioCaptureManager / LocalAudioSourceImpl
ProcessAudioCapturer / Process_Audio_Capturer_Base     ← per-application audio capture
VideoAudioSyncBuffer / SyncedAudioVideoForwardSink / FrameScheduler
TSSharedMemory / TSFrontBackBuffer / TSAVBuffer / TSAVI420Buffer / Buffer / BufferManager
RTCStatsCollectorCallbackLambda                        ← getStats() polling loop
```
- `ProcessAudioCapturer` = capture one application's audio (Windows process loopback), the
  "share game audio, not my Discord notifications" feature.
- `TSSharedMemory` + `TSFrontBackBuffer` = decoded frames handed from the native core to the
  CEF renderer through shared memory with double buffering, instead of copying pixels across
  the process boundary. This is what makes a Chromium UI viable for 60 fps video.
- `RTCStatsCollectorCallbackLambda` = the stats loop that drives adaptive quality decisions.

---

## 6. Techniques worth stealing, ranked

| # | Technique | Why it matters | Where we can get it |
|---|---|---|---|
| 1 | **Split transports: server for voice, P2P for video** | Voice is always-on and mixes well server-side; video is bursty and benefits from a direct path | Architectural choice, free |
| 2 | **Encode once, send to N peers** (`SharedVideoEncoderFactory`) | Turns mesh CPU cost from O(N) to O(1) | In the browser: add **one `MediaStreamTrack` to all `RTCPeerConnection`s** — Chromium shares the encoder when encode params match. Do *not* clone the track per peer |
| 3 | **`contentHint = 'detail'` + `degradationPreference = 'maintain-resolution'` for screen** | Text stays sharp under congestion; drops fps instead of resolution. Mirrors `screenshare_layers.cc` | `track.contentHint`, `sender.setParameters()` |
| 4 | **`playout-delay` header extension** | The explicit latency-vs-smoothness dial, min=0 for interactive | Chromium honours it; settable via SDP munging |
| 5 | **`ptime:10` + `stereo=1` + `useinbandfec=1` Opus at 320 kbps** | 10 ms halves packetization delay; stereo/320k makes shared media audio sound like media, not a phone call | SDP munge on the `a=fmtp:111` line |
| 6 | **Codec preference order AV1 → VP9 → H.264-High → VP8** | AV1 is a large win specifically on screen content | `transceiver.setCodecPreferences()` |
| 7 | **RTX on every payload type, FEC only as backup** | Retransmit is free on a clean link; FEC taxes you permanently | Default in Chromium; just don't disable RTX |
| 8 | **Trickle ICE + fused `joinResponse`** | Saves a full federated RTT on join | Our signaling design |
| 9 | **`reconnectOffer` as a first-class verb** | Network blip resumes instead of rejoining | Our signaling design |
| 10 | **Three capture backends with silent fallback** | WGC → DXGI → GDI; never hard-fail on an old machine | Free in the browser: `getDisplayMedia()` *is* Chromium's WGC/DXGI capturer |
| 11 | **`video-content-type` + `video-timing` extensions** | Production-measurable end-to-end latency breakdown | Enable, then read via `getStats()` |
| 12 | **`network-cost` on overlay/metered interfaces** | Avoids routing a 10 Mbps screen share over Tailscale or a hotspot | ICE does this automatically — do not disable it |
| 13 | **Per-process audio capture** | Share game audio without sharing notifications | Browser: `getDisplayMedia({audio:true})` on Chromium gives tab/system audio; full per-process needs Electron/native |
| 14 | **Shared-memory front/back buffer to the UI layer** | 60 fps video into a Chromium UI without pixel copies | Free in-browser (same process); relevant only if we go Electron-native |
| 15 | **`StreamBase` abstraction over `StreamP2P` / `StreamSFU`** | Mesh for small rooms, SFU when it stops scaling, one call site | Design the interface now even if only mesh ships |

### What to do *better* than TeamSpeak

1. **Ship TURN.** The observed fallback ladder stops at TCP host candidates. Add a
   `coturn` relay (or a managed one) so symmetric-NAT pairs connect at all. This is the single
   biggest reliability difference between "works for my friends" and "works for my friends
   except Pedro".
2. **Mesh has a hard ceiling.** Encode-once fixes CPU, but **upstream bandwidth is still
   O(N)** — a 8 Mbps 1440p60 share to 5 viewers needs 40 Mbps up, which a domestic connection
   does not have. Budget mesh for **≤4 viewers** and keep the `StreamSFU` escape hatch.
3. **Simulcast is absent from the observed offers** (no `a=simulcast`, no `a=rid`), even
   though the machinery is linked in. In a mesh with asymmetric viewers, one viewer on a weak
   link drags the whole stream's bandwidth estimate down. Either offer simulcast/SVC, or
   accept that the slowest viewer sets the quality.

---

## 7. Evidence index

| Artifact | Path |
|---|---|
| Install tree | `%LOCALAPPDATA%\Programs\TeamSpeak\` |
| Client logs (18 sessions, Aug–Oct 2026) | `%LOCALAPPDATA%\TeamSpeak\Logs\Default\ts5client_*.log` |
| Matrix chat log | `%LOCALAPPDATA%\TeamSpeak\Logs\Default\tschat.log` |
| Settings (SQLite, WAL) | `%APPDATA%\TeamSpeak\Default\settings.db`, `tschat_pc.db` |
| Extracted strings (112 370) | `<scratchpad>/ts_dll_strings.txt` |
| Richest session (SDP + ICE) | `ts5client_2026-10-06_20-33.log` — 164 KB, 51 offers / 71 answers / 547 candidates |
| Version line | `ts5client_2026-10-14_00-42.log:3` |

**Confidence:** all topology, protocol, codec and SDP claims are **observed** (log records and
binary symbols). Claims about *why* a parameter was chosen are **inferred** and labelled as
such. The TURN result is a **bounded negative** — bounded by this machine's logs and this
binary's strings, not by TeamSpeak's full deployment.

---

# Appendix A — Discord teardown (comparison target)

Same machine, same method. `%LOCALAPPDATA%\Discord\app-1.0.9261`.

## A.1 Yes, Discord is Electron — and it does not matter

Electron markers, unambiguous:
```
resources/app.asar  3.5M        resources.pak  / chrome_{100,200}_percent.pak
v8_context_snapshot.bin         icudtl.dat      locales/
libGLESv2.dll  vk_swiftshader.dll  vulkan-1.dll  ffmpeg.dll
```

But **zero media runs in JavaScript**. Native addons, by size:
```
modules/discord_voice-2/discord_voice/discord_voice.node     21.1M
modules/discord_krisp-1/discord_krisp/discord_krisp.node     14.4M  + 26M of .kef models
modules/discord_voice-2/discord_voice/mediapipe.dll           8.3M  + selfie_segmentation.tflite
modules/discord_voice-2/discord_voice/gpu_encoder_helper.exe  904K  <- separate process
modules/discord_voice-2/discord_voice/audio_effects_helper.exe 285K <- separate process
modules/discord_media-1/discord_media/discord_media.node       703K
modules/discord_overlay2-1 / discord_hook-1 / discord_game_utils-1   <- in-game overlay
```

## A.2 `discord_voice.node` = libwebrtc, plus their own additions

Build paths surviving in the binary:
```
..\..\modules\congestion_controller\goog_cc\{goog_cc_network_control, delay_based_bwe,
    trendline_estimator, loss_based_bwe_v2, probe_controller, probe_bitrate_estimator,
    alr_detector, acknowledged_bitrate_estimator_interface, robust_throughput_estimator,
    inter_arrival_delta, bitrate_estimator, send_side_bandwidth_estimation}.cc
..\..\api\transport\goog_cc_factory.cc
..\..\media\engine\simulcast_encoder_adapter.cc
..\..\modules\congestion_controller\goog_cc_scream_network_controller\
    goog_cc_scream_network_controller.cc          <- NOT upstream: SCREAM congestion control
../../discord_native_lib/src/media/simulcast_video_stream_factory.cpp   <- their own
```
Same base as TeamSpeak (upstream libwebrtc + GoogCC), but Discord bolted on a **SCREAM**
network controller and their own simulcast stream factory. And unlike TeamSpeak's observed
offers, Discord actually ships simulcast (`simulcast_encoder_adapter.cc`,
`apply_alignment_to_all_simulcast_layers`, `codec_.numberOfSimulcastStreams`).

## A.3 The find that settles the architecture: `gpu_encoder_helper.exe` is **Rust**

Rust toolchain paths leaked into the binary:
```
C:\Users\agent\.cargo\registry\src\index.crates.io-1949cf8c6b5b557f\windows-0.61.1\
    src\Windows\Win32\Media\MediaFoundation\mod.rs
discord_media\components\video\sys\cuda\src\core\error.rs
discord_media\components\video\coding\nvidia-media-encoding\src\native\library.rs
```
Crates identifiable from the registry paths: `windows-0.61.1`, `windows-core-0.61.2`,
`windows-strings-0.4.2`, `clap_builder-4.5.50`, `parking_lot_core-0.9.9`,
`crossbeam-queue-0.3.11`, `log-0.4.29`, `lazy_static-1.5.0`, `anstream-0.6.14`.

All four vendor encode backends, in one Rust process:
```
NVIDIA:  NvEncodeAPICreateInstance, NvEncodeAPIGetMaxSupportedVersion,
         nvencodeapi64.dll / nvencodeapi.dll, nvcuda.dll
AMD:     AMFQueryVersion, AMFVideoEncoderVCE_AVC, AMFVideoEncoderHW_HEVC, AMFVideoEncoderHW_AV1
Intel:   MFXVector<PluginDescriptionRecord>, MFX::DXGI1Device, MFXAudioENCODE_* (VPL)
Generic: MediaFoundationDx11VideoEncoder, MediaFoundationGpuVideoEncoder,
         MFCreateDXGIDeviceManager, MFCreateDXGISurfaceBuffer, ID3D11Device, IDXGIAdapter1
Codecs:  "h264h265av1" / "H264H265AV1"
Dispatch string: "h264h265av1SuccessErrorcudadx11basicNvidiaIntelAmdWindowsMediaFoundation"
```
Operational detail from its own log strings — a tuned, battle-worn component:
```
"Enumerating hardware encoders for codec: "
"Async encoder activated successfully: "      "Failed to unlock async mode for encoder "
"Failed to set adapter LUID on encoder "      "Encoder device failed to set multithreading: "
"Encoder device got ~*~ boosted ~*~"          "Encode reusing capture device"
"# pending frames on encoder shutdown"        "Encoder dropping: "
"MediaFoundationDx11VideoEncoder does not support input format "
```
`Encode reusing capture device` and `set adapter LUID` mean the encoder binds to the **same
D3D11 device/adapter as the capturer** — the captured surface never leaves the GPU.

**Why a separate `.exe`:** GPU drivers crash. Isolating the encoder means a driver fault kills
a helper process, not the call. `audio_effects_helper.exe` is the same pattern for Krisp.

## A.4 What the two teardowns agree on

| | TeamSpeak 6 | Discord |
|---|---|---|
| UI | CEF (Chromium) | Electron (Chromium) |
| Media | native `TeamSpeak.dll` | native `discord_voice.node` |
| Base stack | upstream libwebrtc | upstream libwebrtc |
| Congestion control | GoogCC + transport-cc | GoogCC **+ SCREAM** |
| Encoder strategy | own FFmpeg factory + `NVEncMixin` (C++) | **separate Rust process**, NVENC/QSV/AMF/MF |
| HW vendors probed | QSV, AMF, NVENC | NVENC+CUDA, AMF, QSV/VPL, MF-D3D11 |
| Capture | WGC → DXGI → GDI | D3D11, shares device with encoder |
| Simulcast | machinery linked, **not in observed offers** | shipped (`simulcast_encoder_adapter`) |
| Topology | `StreamP2P` **and** `StreamSFU` | SFU (voice servers) |
| Extras | — | Krisp denoise, MediaPipe selfie segmentation, game overlay |

**The lesson for Mirante, stated once:** both companies ship a web-tech UI and both put
100% of media in native code. The UI toolkit is not the performance decision. The media
pipeline is. Discord's answer to "how do I encode without costing the player FPS" is a
standalone **Rust** process holding NVENC/QSV/AMF and sharing a D3D11 device with the
capturer. That is the target architecture.

## A.5 WebView2 capability audit (for the Tauri decision)

Verified against Microsoft and Chromium sources:

- `getDisplayMedia()` **works** in WebView2 and shows Chromium's own picker. Host gate is the
  `CoreWebView2.ScreenCaptureStarting` event (SDK 1.0.2903.40 / Runtime 131, Nov 2024).
  Screen capture is *not* a `CoreWebView2PermissionKind`.
- `getUserMedia()` and `RTCPeerConnection` fully supported. Gap: Chromium's neural echo
  canceller is Chrome-branding-gated — WebView2 gets AEC3, not the newer model.
- Hardware encode: `kMediaFoundationVideoEncodeAccelerator` is `FEATURE_ENABLED_BY_DEFAULT`
  in `media/base/media_switches.cc`; `media_foundation_video_encode_accelerator_win.cc`
  covers H.264 / VP9 / AV1 / HEVC, reaching NVENC/QSV/AMF through the driver's MF transform.
  Per-driver workaround flags can still disable paths.
- **Open WebView2 defects that bite this exact use case:**
  - window capture throttled to ~5 FPS — [WebView2Feedback #4176](https://github.com/MicrosoftEdge/WebView2Feedback/issues/4176)
  - low framerate / audio-video desync on desktop capture — [#2905](https://github.com/MicrosoftEdge/WebView2Feedback/issues/2905)
  - app freeze when switching focus during active WebRTC capture — [#2258](https://github.com/MicrosoftEdge/WebView2Feedback/issues/2258)
  - second monitor missing from picker — [#1850](https://github.com/MicrosoftEdge/WebView2Feedback/issues/1850)
  - picker clipped to WebView2 control bounds — [#2184](https://github.com/MicrosoftEdge/WebView2Feedback/issues/2184)
- Rust media alternatives: `livekit/rust-sdks` (`webrtc-sys`) wraps real libwebrtc and has
  desktop capture, but its feature matrix lists hardware encode for macOS/iOS and Linux —
  **Windows hardware encode is not listed**. `webrtc-rs` is transport-only (ICE/DTLS/SRTP/RTP,
  TWCC and NACK interceptors) and **ships no video encoder at all** — you feed it encoded
  frames, which is precisely the Discord shape.
- macOS note: WKWebView does **not** support `getDisplayMedia`, so any webview-side capture
  plan is Windows-only by construction.
