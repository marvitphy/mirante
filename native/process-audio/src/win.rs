//! Windows WASAPI backend for per-process loopback capture.
//!
//! Implements `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`, available from
//! Windows 10 build 20348. The activation is asynchronous and goes through
//! `ActivateAudioInterfaceAsync`, so we implement the COM completion handler
//! and block the capture thread until it fires.
//!
//! Built in CI on windows-latest; see .github/workflows/native.yml.

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;

use parking_lot::Mutex;
use windows::core::{
    implement, Error as WinError, Interface, Result as WinResult, GUID, HRESULT, PCWSTR,
};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, MAX_PATH, S_OK, WAIT_OBJECT_0};
use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
use windows::Win32::Media::Audio::{
    eConsole, eRender, ActivateAudioInterfaceAsync, AudioSessionStateActive,
    IActivateAudioInterfaceAsyncOperation, IActivateAudioInterfaceCompletionHandler,
    IActivateAudioInterfaceCompletionHandler_Impl, IAudioCaptureClient, IAudioClient,
    IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
    AUDCLNT_STREAMFLAGS_LOOPBACK, AUDIOCLIENT_ACTIVATION_PARAMS,
    AUDIOCLIENT_ACTIVATION_PARAMS_0, AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
    AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
    WAVEFORMATEX, WAVEFORMATEXTENSIBLE, WAVEFORMATEXTENSIBLE_0,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, BLOB, CLSCTX_ALL,
    COINIT_MULTITHREADED,
};
use windows::Win32::System::Threading::{
    CreateEventW, OpenProcess, QueryFullProcessImageNameW, SetEvent, WaitForMultipleObjects,
    WaitForSingleObject, INFINITE, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
};

/// Two constants we declare rather than import.
///
/// `KSDATAFORMAT_SUBTYPE_IEEE_FLOAT` and `WAVE_FORMAT_EXTENSIBLE` live in
/// feature-gated modules that move between releases of the `windows` crate.
/// They are fixed values defined by the Windows audio ABI and will never
/// change, so hard-coding them costs nothing and removes two feature flags.
const KSDATAFORMAT_SUBTYPE_IEEE_FLOAT: GUID =
    GUID::from_u128(0x0000_0003_0000_0010_8000_00aa_0038_9b71);
const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;

/// Layout-compatible stand-in for `PROPVARIANT`.
///
/// `ActivateAudioInterfaceAsync` wants activation parameters as a `VT_BLOB`
/// PROPVARIANT. The `windows` crate models the union opaquely and has moved
/// the type between modules across versions, so we declare the exact shape the
/// audio ABI documents and pass a pointer to it.
#[repr(C)]
#[derive(Clone, Copy)]
struct BlobPropVariant {
    vt: u16,
    reserved1: u16,
    reserved2: u16,
    reserved3: u16,
    blob: BLOB,
}

const VT_BLOB_TAG: u16 = 65;

use crate::LoopbackMode;

/// Fixed capture format. The process-loopback virtual device has no mix format
/// to query, so we declare one. 48 kHz stereo float is what WebRTC wants anyway.
pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: u32 = 2;
const BITS_PER_SAMPLE: u16 = 32;
/// 20 ms of slack. Long enough to survive a scheduling hiccup, short enough that
/// the added latency is below the jitter buffer's own floor.
const BUFFER_DURATION_100NS: i64 = 20 * 10_000;

/// Per-process loopback landed in Windows 10 21H2 server build 20348.
const MIN_BUILD: u32 = 20348;

/// Which process owns a window.
///
/// Electron names a window capture source `window:<hwnd>:<n>`, so the HWND is
/// already in our hands — this turns it into the pid whose audio we should
/// capture. Sharing a window should send that window's sound and nothing
/// else, which means nobody has to be asked which app they meant.
pub fn pid_for_window(hwnd: isize) -> Option<u32> {
    let mut pid: u32 = 0;
    // SAFETY: GetWindowThreadProcessId tolerates an invalid handle by
    // returning 0 and leaving `pid` untouched; we check both.
    let thread = unsafe { GetWindowThreadProcessId(HWND(hwnd as *mut _), Some(&mut pid)) };
    if thread == 0 || pid == 0 {
        None
    } else {
        Some(pid)
    }
}

pub fn is_supported() -> bool {
    windows_build() >= MIN_BUILD
}

fn windows_build() -> u32 {
    // RtlGetVersion is the only version API that is not shimmed by app compat.
    #[link(name = "ntdll")]
    extern "system" {
        fn RtlGetVersion(info: *mut OsVersionInfoW) -> i32;
    }

    #[repr(C)]
    struct OsVersionInfoW {
        dw_os_version_info_size: u32,
        dw_major_version: u32,
        dw_minor_version: u32,
        dw_build_number: u32,
        dw_platform_id: u32,
        sz_csd_version: [u16; 128],
    }

    let mut info = OsVersionInfoW {
        dw_os_version_info_size: std::mem::size_of::<OsVersionInfoW>() as u32,
        dw_major_version: 0,
        dw_minor_version: 0,
        dw_build_number: 0,
        dw_platform_id: 0,
        sz_csd_version: [0; 128],
    };
    // SAFETY: `info` is correctly sized and lives for the duration of the call.
    unsafe {
        if RtlGetVersion(&mut info) == 0 {
            info.dw_build_number
        } else {
            0
        }
    }
}

// ---------------------------------------------------------------------------
// COM scope guard
// ---------------------------------------------------------------------------

/// A `HANDLE` that may cross a thread boundary.
///
/// `HANDLE` is a raw pointer and therefore not `Send`, but a Windows event
/// handle is explicitly thread-safe: `SetEvent` and `WaitFor*` are documented
/// as callable from any thread, and ours is created by this module, signalled
/// from at most two threads, and closed exactly once after the capture thread
/// has joined.
#[derive(Clone, Copy)]
struct EventHandle(HANDLE);

// SAFETY: see the type comment — the underlying Win32 object is thread-safe
// and its lifetime is bounded by `Capture`, which joins before closing it.
unsafe impl Send for EventHandle {}
unsafe impl Sync for EventHandle {}

impl EventHandle {
    fn raw(self) -> HANDLE {
        self.0
    }
}

/// RAII COM initialisation that tolerates an already-initialised thread.
///
/// Electron's main thread is already a single-threaded apartment, so asking
/// for `COINIT_MULTITHREADED` there returns `RPC_E_CHANGED_MODE` rather than
/// succeeding. That is not a failure: COM is usable, just under a different
/// apartment model, and WASAPI enumeration works fine in an STA.
///
/// Treating it as an error is what made `listAudioApps()` come back empty
/// inside the app while working perfectly from a bare Node process, where
/// nothing had initialised COM yet.
///
/// `owned` records whether we were the ones who initialised, because only
/// then may we call `CoUninitialize`.
struct ComScope {
    owned: bool,
}

/// `RPC_E_CHANGED_MODE` — the thread is already in a different apartment.
const RPC_E_CHANGED_MODE: HRESULT = HRESULT(0x8001_0106_u32 as i32);

impl ComScope {
    fn enter() -> WinResult<Self> {
        // SAFETY: balanced by CoUninitialize in Drop, and only when we own it.
        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if hr == RPC_E_CHANGED_MODE {
            return Ok(Self { owned: false });
        }
        hr.ok()?;
        Ok(Self { owned: true })
    }
}

impl Drop for ComScope {
    fn drop(&mut self) {
        if !self.owned {
            return;
        }
        // SAFETY: balances the CoInitializeEx in `enter`.
        unsafe { CoUninitialize() };
    }
}

// ---------------------------------------------------------------------------
// Audio session enumeration (for the picker)
// ---------------------------------------------------------------------------

pub fn list_audio_apps() -> WinResult<Vec<crate::AudioApp>> {
    let _com = ComScope::enter()?;

    // SAFETY: standard WASAPI enumeration; every interface is checked by `?`.
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
        let manager: IAudioSessionManager2 = device.Activate(CLSCTX_ALL, None)?;
        let sessions = manager.GetSessionEnumerator()?;

        let count = sessions.GetCount()?;
        let mut apps: Vec<crate::AudioApp> = Vec::with_capacity(count as usize);

        for index in 0..count {
            let control = sessions.GetSession(index)?;
            let Ok(control2) = control.cast::<IAudioSessionControl2>() else {
                continue;
            };

            // The system sounds session reports pid 0 and cannot be targeted.
            let pid = control2.GetProcessId().unwrap_or(0);
            if pid == 0 {
                continue;
            }
            if apps.iter().any(|a| a.pid == pid) {
                continue;
            }

            let executable = executable_name(pid).unwrap_or_else(|| format!("pid {pid}"));
            let display_name = control2
                .GetDisplayName()
                .ok()
                .and_then(|raw| {
                    let text = raw.to_string().ok()?;
                    CoTaskMemFree(Some(raw.0 as *const c_void));
                    if text.trim().is_empty() {
                        None
                    } else {
                        Some(text)
                    }
                })
                .unwrap_or_else(|| executable.clone());

            let active = matches!(control2.GetState(), Ok(state) if state == AudioSessionStateActive);

            apps.push(crate::AudioApp {
                pid,
                executable,
                display_name,
                active,
            });
        }

        // Apps that are actually making noise float to the top of the picker.
        apps.sort_by(|a, b| {
            b.active
                .cmp(&a.active)
                .then_with(|| a.display_name.to_lowercase().cmp(&b.display_name.to_lowercase()))
        });
        Ok(apps)
    }
}

fn executable_name(pid: u32) -> Option<String> {
    // SAFETY: handle is closed on every path; buffer length is passed by pointer
    // and clamped by the API.
    unsafe {
        let handle: HANDLE = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buffer = [0u16; MAX_PATH as usize];
        let mut len = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_FORMAT(0),
            windows::core::PWSTR(buffer.as_mut_ptr()),
            &mut len,
        )
        .is_ok();
        let _ = CloseHandle(handle);
        if !ok {
            return None;
        }
        let full = String::from_utf16_lossy(&buffer[..len as usize]);
        Some(
            full.rsplit(['\\', '/'])
                .next()
                .unwrap_or(&full)
                .to_owned(),
        )
    }
}

// ---------------------------------------------------------------------------
// Async activation completion handler
// ---------------------------------------------------------------------------

/// `ActivateAudioInterfaceAsync` completes on a system thread. This handler just
/// signals an event; the capture thread blocks on it and then reads the result.
#[implement(IActivateAudioInterfaceCompletionHandler)]
struct ActivationHandler {
    done: EventHandle,
}

impl IActivateAudioInterfaceCompletionHandler_Impl for ActivationHandler_Impl {
    fn ActivateCompleted(
        &self,
        _operation: Option<&IActivateAudioInterfaceAsyncOperation>,
    ) -> WinResult<()> {
        // SAFETY: `done` outlives the operation — the capture thread owns it and
        // waits on it before dropping.
        unsafe { SetEvent(self.done.raw()) }
    }
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

pub struct Capture {
    target_pid: u32,
    mode: LoopbackMode,
    running: Arc<AtomicBool>,
    stop_event: EventHandle,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl Capture {
    pub fn open(target_pid: u32, mode: LoopbackMode) -> WinResult<Self> {
        if !is_supported() {
            return Err(WinError::new(
                windows::core::HRESULT(-1),
                format!(
                    "per-process loopback needs Windows build {MIN_BUILD}+, this is {}",
                    windows_build()
                ),
            ));
        }
        // SAFETY: manual-reset event, initially unsignalled.
        let stop_event = EventHandle(unsafe { CreateEventW(None, true, false, PCWSTR::null())? });
        Ok(Self {
            target_pid,
            mode,
            running: Arc::new(AtomicBool::new(false)),
            stop_event,
            thread: Mutex::new(None),
        })
    }

    pub fn start<F>(&mut self, on_data: F) -> WinResult<()>
    where
        F: FnMut(&[u8]) + Send + 'static,
    {
        if self.running.swap(true, Ordering::SeqCst) {
            return Ok(());
        }

        let target_pid = self.target_pid;
        let mode = self.mode;
        let running = Arc::clone(&self.running);
        let stop_event = self.stop_event;

        let handle = std::thread::Builder::new()
            .name("mirante-process-audio".to_owned())
            .spawn(move || {
                if let Err(err) = capture_loop(target_pid, mode, stop_event, &running, on_data) {
                    eprintln!("[process-audio] capture stopped: {err}");
                }
                running.store(false, Ordering::SeqCst);
            })
            .map_err(|e| WinError::new(windows::core::HRESULT(-1), e.to_string()))?;

        *self.thread.lock() = Some(handle);
        Ok(())
    }

    pub fn stop(&mut self) -> WinResult<()> {
        // SAFETY: the event is valid until this function closes it below.
        unsafe { SetEvent(self.stop_event.raw())? };
        if let Some(handle) = self.thread.lock().take() {
            let _ = handle.join();
        }
        // SAFETY: thread has joined, so nothing can wait on the handle any more.
        unsafe { CloseHandle(self.stop_event.raw())? };
        Ok(())
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        if self.running.load(Ordering::SeqCst) {
            let _ = self.stop();
        }
    }
}

fn capture_format() -> WAVEFORMATEXTENSIBLE {
    let block_align = (CHANNELS as u16) * (BITS_PER_SAMPLE / 8);
    WAVEFORMATEXTENSIBLE {
        Format: WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_EXTENSIBLE,
            nChannels: CHANNELS as u16,
            nSamplesPerSec: SAMPLE_RATE,
            nAvgBytesPerSec: SAMPLE_RATE * block_align as u32,
            nBlockAlign: block_align,
            wBitsPerSample: BITS_PER_SAMPLE,
            cbSize: (std::mem::size_of::<WAVEFORMATEXTENSIBLE>()
                - std::mem::size_of::<WAVEFORMATEX>()) as u16,
        },
        Samples: WAVEFORMATEXTENSIBLE_0 {
            wValidBitsPerSample: BITS_PER_SAMPLE,
        },
        // Stereo front left + front right.
        dwChannelMask: 0x3,
        SubFormat: KSDATAFORMAT_SUBTYPE_IEEE_FLOAT,
    }
}

fn capture_loop<F>(
    target_pid: u32,
    mode: LoopbackMode,
    stop_event: EventHandle,
    running: &AtomicBool,
    mut on_data: F,
) -> WinResult<()>
where
    F: FnMut(&[u8]) + Send + 'static,
{
    let _com = ComScope::enter()?;

    // SAFETY: every COM call below is checked; raw pointers point at locals that
    // outlive the calls that read them.
    unsafe {
        let mut activation_params = AUDIOCLIENT_ACTIVATION_PARAMS {
            ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                    TargetProcessId: target_pid,
                    ProcessLoopbackMode: match mode {
                        LoopbackMode::IncludeTree => {
                            PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
                        }
                        LoopbackMode::ExcludeTree => {
                            PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE
                        }
                    },
                },
            },
        };

        // The activation params ride inside a VT_BLOB PROPVARIANT.
        let mut propvariant = BlobPropVariant {
            vt: VT_BLOB_TAG,
            reserved1: 0,
            reserved2: 0,
            reserved3: 0,
            blob: BLOB {
                cbSize: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                pBlobData: &mut activation_params as *mut _ as *mut u8,
            },
        };

        let done = EventHandle(CreateEventW(None, true, false, PCWSTR::null())?);
        let handler: IActivateAudioInterfaceCompletionHandler =
            ActivationHandler { done }.into();

        let operation: IActivateAudioInterfaceAsyncOperation = ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(&propvariant as *const BlobPropVariant as *const _),
            &handler,
        )?;

        WaitForSingleObject(done.raw(), INFINITE);
        let _ = CloseHandle(done.raw());

        let mut activate_result = S_OK;
        let mut activated: Option<windows::core::IUnknown> = None;
        operation.GetActivateResult(&mut activate_result, &mut activated)?;
        activate_result.ok()?;

        let client: IAudioClient = activated
            .ok_or_else(|| {
                WinError::new(
                    windows::core::HRESULT(-1),
                    "activation returned no interface",
                )
            })?
            .cast()?;

        let format = capture_format();
        client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
            BUFFER_DURATION_100NS,
            0,
            &format as *const _ as *const WAVEFORMATEX,
            None,
        )?;

        let sample_ready = CreateEventW(None, false, false, PCWSTR::null())?;
        client.SetEventHandle(sample_ready)?;

        let capture: IAudioCaptureClient = client.GetService()?;
        client.Start()?;

        let frame_bytes = format.Format.nBlockAlign as usize;
        let wait_handles = [sample_ready, stop_event.raw()];

        loop {
            // Wake on either "a buffer is ready" or "stop was requested".
            let signalled = WaitForMultipleObjects(&wait_handles, false, INFINITE);
            if signalled.0 != WAIT_OBJECT_0.0 {
                break; // stop_event, or an abandoned wait
            }
            if !running.load(Ordering::SeqCst) {
                break;
            }

            // Drain every packet the endpoint has queued, not just one.
            loop {
                let available = capture.GetNextPacketSize()?;
                if available == 0 {
                    break;
                }

                let mut data: *mut u8 = std::ptr::null_mut();
                let mut frames: u32 = 0;
                let mut flags: u32 = 0;
                capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None)?;

                if frames > 0 {
                    let len = frames as usize * frame_bytes;
                    if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 {
                        // The endpoint signals digital silence rather than
                        // writing zeroes. Synthesise them so downstream timing
                        // stays continuous.
                        on_data(&vec![0u8; len]);
                    } else if !data.is_null() {
                        on_data(std::slice::from_raw_parts(data, len));
                    }
                }
                capture.ReleaseBuffer(frames)?;
            }
        }

        let _ = client.Stop();
        let _ = CloseHandle(sample_ready);
        Ok(())
    }
}
