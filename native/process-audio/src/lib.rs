//! Per-process audio loopback capture for Windows.
//!
//! # Why this exists
//!
//! System-wide loopback (`WASAPI` on the default render endpoint, which is what
//! Electron's `audio: 'loopback'` gives you) captures *everything* coming out of
//! the speakers. If you are in a voice call while sharing your screen, your
//! friends hear themselves back with a delay. That is the echo.
//!
//! Windows 10 build 20348+ / Windows 11 exposes `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`,
//! which captures audio from a *single process tree* instead of the whole endpoint.
//! Point it at the game you are sharing and the voice chat is simply never in the
//! buffer — not filtered out, never captured.
//!
//! The TeamSpeak and Discord teardowns in `docs/teamspeak-rtc-teardown.md` both
//! show this component:
//!   - TeamSpeak: `com::teamspeak::video::ProcessAudioCapturer`
//!   - Discord:   `audio_effects_helper.exe`, and a Rust `gpu_encoder_helper.exe`
//!     alongside it.
//!
//! # Modes
//!
//! * [`LoopbackMode::IncludeTree`] — capture ONLY this process tree. Used when you
//!   share a specific window: you get the game, nothing else. This is the setting
//!   that makes echo structurally impossible.
//! * [`LoopbackMode::ExcludeTree`] — capture everything EXCEPT this process tree.
//!   Used when you share a whole monitor: pass Mirante's own pid so our own
//!   voice output is excluded.

#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

#[cfg(windows)]
mod win;

#[cfg(windows)]
use win as backend;

/// Which side of the process tree to keep.
#[napi(string_enum)]
#[derive(Debug, Clone, Copy)]
pub enum LoopbackMode {
    /// Capture only audio produced by the target process and its children.
    IncludeTree,
    /// Capture all audio except that of the target process and its children.
    ExcludeTree,
}

/// A process currently holding an audio session, for the source picker.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct AudioApp {
    pub pid: u32,
    /// Executable name, e.g. `"eldenring.exe"`.
    pub executable: String,
    /// Friendly name from the audio session, falling back to the executable.
    pub display_name: String,
    /// True while the session is actively rendering, not merely open.
    pub active: bool,
}

/// Format the capture always produces. Fixed rather than negotiated, because the
/// process-loopback virtual device does not implement `GetMixFormat`, and WebRTC
/// wants 48 kHz stereo float anyway.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct CaptureFormat {
    pub sample_rate: u32,
    pub channels: u32,
    /// Always `"f32"` — 32-bit float, interleaved.
    pub sample_format: String,
}

/// Whether this Windows build supports per-process loopback at all.
///
/// Returns `false` on Windows 10 before build 20348, and on every non-Windows
/// platform. Callers must degrade gracefully: offer "no audio" or warn about
/// echo before falling back to system-wide loopback.
#[napi]
pub fn is_supported() -> bool {
    #[cfg(windows)]
    {
        backend::is_supported()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Enumerate processes that currently own an audio session.
///
/// Used to populate the "which app's audio do you want to send?" picker when the
/// user shares a whole monitor and there is no single obvious process.
#[napi]
pub fn list_audio_apps() -> Result<Vec<AudioApp>> {
    #[cfg(windows)]
    {
        backend::list_audio_apps().map_err(|e| Error::new(Status::GenericFailure, e.to_string()))
    }
    #[cfg(not(windows))]
    {
        Ok(Vec::new())
    }
}

/// A running capture. Dropping or calling [`ProcessAudioCapture::stop`] releases
/// the device and joins the capture thread.
#[napi]
pub struct ProcessAudioCapture {
    #[cfg(windows)]
    inner: Option<backend::Capture>,
    #[cfg(not(windows))]
    inner: Option<()>,
    format: CaptureFormat,
}

#[napi]
impl ProcessAudioCapture {
    /// Open a capture against `target_pid`.
    ///
    /// The capture does not start producing audio until [`start`] is called with
    /// a callback.
    ///
    /// [`start`]: ProcessAudioCapture::start
    #[napi(constructor)]
    pub fn new(target_pid: u32, mode: LoopbackMode) -> Result<Self> {
        #[cfg(windows)]
        {
            let inner = backend::Capture::open(target_pid, mode)
                .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
            Ok(Self {
                format: CaptureFormat {
                    sample_rate: backend::SAMPLE_RATE,
                    channels: backend::CHANNELS,
                    sample_format: "f32".to_owned(),
                },
                inner: Some(inner),
            })
        }
        #[cfg(not(windows))]
        {
            let _ = (target_pid, mode);
            Err(Error::new(
                Status::GenericFailure,
                "per-process loopback is Windows-only",
            ))
        }
    }

    #[napi(getter)]
    pub fn format(&self) -> CaptureFormat {
        self.format.clone()
    }

    /// Begin delivering interleaved f32 PCM to `on_data`.
    ///
    /// The callback runs on the libuv thread pool, not the capture thread, so it
    /// is safe to touch JS state from it. Buffers are not reused — each call owns
    /// its bytes.
    #[napi(ts_args_type = "onData: (chunk: Buffer) => void")]
    pub fn start(&mut self, on_data: ThreadsafeFunction<Buffer, ErrorStrategy::Fatal>) -> Result<()> {
        #[cfg(windows)]
        {
            let capture = self
                .inner
                .as_mut()
                .ok_or_else(|| Error::new(Status::InvalidArg, "capture already stopped"))?;

            capture
                .start(move |pcm: &[u8]| {
                    on_data.call(
                        Buffer::from(pcm.to_vec()),
                        ThreadsafeFunctionCallMode::NonBlocking,
                    );
                })
                .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))
        }
        #[cfg(not(windows))]
        {
            let _ = on_data;
            Err(Error::new(
                Status::GenericFailure,
                "per-process loopback is Windows-only",
            ))
        }
    }

    /// Stop capturing and release the device. Idempotent.
    #[napi]
    pub fn stop(&mut self) -> Result<()> {
        #[cfg(windows)]
        if let Some(mut capture) = self.inner.take() {
            capture
                .stop()
                .map_err(|e| Error::new(Status::GenericFailure, e.to_string()))?;
        }
        #[cfg(not(windows))]
        {
            self.inner.take();
        }
        Ok(())
    }
}
