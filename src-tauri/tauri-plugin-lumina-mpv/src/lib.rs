//! `tauri-plugin-lumina-mpv` — native libmpv engine for Lúmina Play desktop.
//!
//! M1 scope: real `play / pause / resume / stop` backed by libmpv2 in a
//! standalone mpv window (`force-window=yes`). The HWND embed into the
//! Tauri window lands in M2.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

#[cfg(target_os = "windows")]
use libmpv2::Mpv;

#[cfg(target_os = "windows")]
use windows::{
    core::{w, PCWSTR},
    Win32::{
        Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, POINT, WPARAM},
        Graphics::Gdi::ClientToScreen,
        UI::WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DestroyWindow, RegisterClassExW,
            SetWindowPos, HMENU, HTTRANSPARENT, HWND_TOP, SWP_NOACTIVATE,
            SWP_NOMOVE, SWP_NOSIZE, WM_NCHITTEST, WNDCLASSEXW, WS_EX_NOACTIVATE,
            WS_POPUP, WS_VISIBLE,
        },
    },
};

// ----------- shared types -----------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Track {
    pub id: i64,
    pub kind: String,
    pub lang: Option<String>,
    pub title: Option<String>,
    pub codec: Option<String>,
    pub selected: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct PlaybackState {
    pub playing: bool,
    pub buffering: bool,
    pub position: f64,
    pub duration: f64,
    /// mpv's `eof-reached`. With `keep-open=yes` the file stays loaded and
    /// paused on the last frame instead of unloading, so this is the only
    /// signal React has that a VOD finished (there's no `ended` event on
    /// the `<video>` element — it never played anything on this path).
    pub eof: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct PlayOptions {
    pub headers: Option<std::collections::HashMap<String, String>>,
    pub start_time: Option<f64>,
}

// ----------- engine state -----------

#[cfg(target_os = "windows")]
struct MpvEngine {
    mpv: Mutex<Option<Mpv>>,
    // Raw HWND of the popup window we created and handed to mpv. Stored
    // as isize because HWND is !Send; we only need the value for later
    // SetWindowPos calls, never to dereference it ourselves.
    child_hwnd: Mutex<Option<isize>>,
    // Last viewport React asked us to put the popup at, in client-area
    // coordinates (x, y, w, h). We replay these through ClientToScreen
    // whenever the Tauri window moves or resizes so the popup follows.
    last_viewport: Mutex<Option<(i32, i32, u32, u32)>>,
    // Last URL play() dispatched to libmpv. We set this immediately,
    // before loadfile returns, so React Strict Mode's double-fire of
    // useEffect doesn't send two overlapping loadfile commands — the
    // mpv `path` property isn't updated synchronously by loadfile.
    last_url: Mutex<Option<String>>,
    // Whether we've registered the on_window_event listener that drives
    // the follow-the-window behaviour. One-shot flag to avoid stacking
    // multiple listeners if `play()` is invoked repeatedly.
    listener_installed: Mutex<bool>,
}

#[cfg(target_os = "windows")]
impl Drop for MpvEngine {
    fn drop(&mut self) {
        // Order matters: drop mpv (libmpv2's Drop calls
        // mpv_terminate_destroy and joins the render thread) BEFORE we
        // destroy the HWND it was pointed at. Reversing the order leaves
        // mpv's render thread briefly holding a dangling HWND, which was
        // the source of the STATUS_UNHANDLED_EXCEPTION (0xcfffffff) we hit
        // on window close during M2b.
        if let Ok(mut guard) = self.mpv.lock() {
            let _ = guard.take();
        }
        if let Ok(guard) = self.child_hwnd.lock() {
            if let Some(child) = *guard {
                // If the parent window has already been destroyed by the
                // OS, this call fails harmlessly — the child was auto-
                // reaped. We swallow the error either way.
                unsafe {
                    let _ = DestroyWindow(HWND(child as *mut _));
                }
            }
        }
    }
}

/// Window procedure for our popup HWND. We only need to override one
/// message: WM_NCHITTEST. Returning `HTTRANSPARENT` tells Windows "this
/// window should be ignored for mouse hit-testing" — the OS then re-runs
/// the hit-test on the window immediately beneath us (the Tauri main
/// window hosting WebView2). That means mouse-move, click, scroll and
/// cursor-over events ALL pass straight through the mpv surface and
/// reach React, so the controls-autohide timer resets normally when the
/// user wiggles the mouse over the "video" area, and `onClick={togglePlay}`
/// on `<video>` still works. Everything else (paint, resize, destroy)
/// still goes to DefWindowProc so mpv's render path is unaffected.
#[cfg(target_os = "windows")]
unsafe extern "system" fn host_wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_NCHITTEST {
        return LRESULT(HTTRANSPARENT as isize);
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

/// Register our custom "LuminaMpvHost" class once per process.
/// `RegisterClassExW` returns 0 and sets `ERROR_CLASS_ALREADY_EXISTS` on
/// subsequent calls, which we treat as success — the class is still
/// available for CreateWindowExW. hbrBackground is left as NULL so we
/// don't paint over mpv's framebuffer between resize/erase messages
/// (a BLACK_BRUSH there caused Mpv::with_initializer to silently fail
/// during M2b experiments — mpv was reading the surface it was supposed
/// to draw into and bailing).
#[cfg(target_os = "windows")]
fn ensure_window_class() -> Result<PCWSTR, String> {
    // PCWSTR is `*const u16` under the hood, which isn't Sync, so we can't
    // park it in a `static`. The `w!` macro builds the UTF-16 literal at
    // compile time and we just read it twice (once to register, once to
    // return) — same bytes, same pointer.
    static REGISTERED: std::sync::Once = std::sync::Once::new();
    static REGISTER_ERROR: std::sync::Mutex<Option<String>> =
        std::sync::Mutex::new(None);

    REGISTERED.call_once(|| unsafe {
        let cls = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(host_wnd_proc),
            lpszClassName: w!("LuminaMpvHost"),
            ..Default::default()
        };
        if RegisterClassExW(&cls) == 0 {
            // ERROR_CLASS_ALREADY_EXISTS (1410) is fine — the class
            // name is per-process and some test harnesses re-init.
            let err = windows::Win32::Foundation::GetLastError();
            if err.0 != 1410 {
                if let Ok(mut g) = REGISTER_ERROR.lock() {
                    *g = Some(format!("RegisterClassExW failed: {err:?}"));
                }
            }
        }
    });

    if let Ok(g) = REGISTER_ERROR.lock() {
        if let Some(e) = g.as_ref() {
            return Err(e.clone());
        }
    }
    Ok(w!("LuminaMpvHost"))
}

#[cfg(target_os = "windows")]
impl MpvEngine {
    fn new() -> Self {
        Self {
            mpv: Mutex::new(None),
            child_hwnd: Mutex::new(None),
            last_viewport: Mutex::new(None),
            last_url: Mutex::new(None),
            listener_installed: Mutex::new(false),
        }
    }

    /// Lazily create a child window inside the Tauri main window and the
    /// Mpv instance that renders into it.
    ///
    /// IMPORTANT: Win32 requires windows to be created and modified from
    /// the thread that owns the parent (the UI thread). Our Tauri commands
    /// run on tokio workers, so this function expects to be called inside
    /// a `window.run_on_main_thread(...)` closure. Calling it from a
    /// tokio thread works for a bit but eventually clogs the UI message
    /// pump — we hit a "Lúmina Play (Não está respondendo)" freeze during
    /// M2b testing exactly because of that.
    fn ensure_mpv(
        &self,
        parent_hwnd_raw: isize,
    ) -> Result<(), String> {
        let mut guard = self.mpv.lock().map_err(|e| format!("mutex poisoned: {e}"))?;
        if guard.is_some() {
            return Ok(());
        }
        let parent_hwnd = HWND(parent_hwnd_raw as *mut _);

        // Top-level WS_POPUP owned by the Tauri main window — NOT a
        // WS_CHILD inside it. We tried WS_CHILD in M2b and the mpv surface
        // kept rendering behind the React UI, because WebView2 paints via
        // DirectComposition which bypasses in-window HWND Z-order. A
        // separate top-level window has its own desktop surface and sits
        // above its owner naturally.
        //
        // Custom "LuminaMpvHost" class whose WNDPROC returns HTTRANSPARENT
        // on WM_NCHITTEST — see host_wnd_proc above. This is what lets
        // mouse events (move, click, scroll) pass through the mpv popup
        // and reach the React controls on the WebView beneath, so the
        // auto-hide bar wakes up on cursor wiggle like on any normal
        // video player. STATIC worked for pure painting but ate every
        // pointer event that landed on the popup.
        let class_name = ensure_window_class()?;
        let child = unsafe {
            CreateWindowExW(
                WS_EX_NOACTIVATE,
                class_name,
                PCWSTR::null(),
                WS_POPUP | WS_VISIBLE,
                0,
                0,
                1280,
                720,
                Some(parent_hwnd),
                None::<HMENU>,
                None::<HINSTANCE>,
                None,
            )
        }
        .map_err(|e| format!("CreateWindowExW: {e:?}"))?;

        let child_raw = child.0 as isize;
        log::info!(
            "[lumina-mpv] created popup HWND {child_raw:#x} owned by {parent_hwnd_raw:#x}"
        );

            let mpv = Mpv::with_initializer(|init| {
                // Keep user mpv.conf OUT. Letting it load made
                // Mpv::with_initializer fail silently on this user's
                // machine (ensure_mpv came back Err, so each play() call
                // created another orphan popup — the "quebrada" windows
                // the user saw). The IPTV workarounds users typically put
                // in their mpv.conf (UA, headers, redirect follows) we
                // handle below ourselves.
                init.set_option("config", "no")?;
                init.set_option("load-scripts", "no")?;

                init.set_option("vo", "gpu")?;
                // wid points at our brand new child HWND, not the main
                // window. mpv treats it as its drawable; WebView2 continues
                // owning the rest of the window.
                init.set_option("wid", child_raw as i64)?;
                init.set_option("keep-open", "yes")?;
                // (Window background is handled at the Win32 level — the
                //  class hbrBackground is set to BLACK_BRUSH when we
                //  CreateWindowExW below. mpv's `--background` option
                //  only paints the idle logo area, not the HWND itself,
                //  and some color formats are version-sensitive.)
                init.set_option("osc", "no")?;
                init.set_option("input-default-bindings", "no")?;
                init.set_option("input-vo-keyboard", "no")?;

                init.set_option("hwdec", "auto-safe")?;
                init.set_option("ytdl", "no")?;

                // Many IPTV providers reject mpv's default User-Agent and
                // only serve clients that look like VLC — we hit this on
                // vsplay.fun during M3 testing (curl got "Opening failed
                // or was aborted" immediately). The VPS proxy already
                // rewrites the UA for the web build; replicate the same
                // string here for the desktop path.
                init.set_option("user-agent", "VLC/3.0.20 LibVLC/3.0.20")?;
                // 302 redirects (vsplay.fun / Xtream over Cloudflare) are
                // resolved on the TS side via tauri-plugin-http before
                // play() hits us, so mpv's native curl backend only ever
                // sees the final CDN URL — no need for ffmpeg-lavf
                // override here. The `stream-lavf-o-add` option tried
                // earlier isn't recognised by every libmpv build and made
                // Mpv::with_initializer fail silently on this one.

                init.set_option("terminal", "yes")?;
                init.set_option("msg-level", "all=v")?;

                Ok(())
            })
            .map_err(|e| format!("Mpv::with_initializer failed: {e:?}"))?;

        log::info!("[lumina-mpv] Mpv instance ready (M2b, child HWND)");
        *guard = Some(mpv);
        *self
            .child_hwnd
            .lock()
            .map_err(|e| format!("child_hwnd mutex: {e}"))? = Some(child_raw);
        Ok(())
    }
}

// ----------- commands -----------

/// Install (once per MpvEngine instance) a Tauri window event listener
/// that re-applies the last viewport whenever the main window moves or
/// resizes. The mpv surface is a top-level popup — if we don't do this,
/// the user drags the Lúmina window and the video stays in place over
/// the old screen coordinates.
///
/// We fire-and-forget on_main() inside the callback: the event thread
/// isn't the UI thread, so we hop via run_on_main_thread. Errors are
/// silently logged — a transient failure shouldn't take down playback.
#[cfg(target_os = "windows")]
fn install_window_listener<R: Runtime>(window: &tauri::Window<R>) {
    use tauri::WindowEvent;
    let app = window.app_handle().clone();
    let win = window.clone();
    window.on_window_event(move |ev| {
        if !matches!(ev, WindowEvent::Moved(_) | WindowEvent::Resized(_)) {
            return;
        }
        let engine = app.state::<MpvEngine>();
        let (child, parent, rect) = {
            let child = match engine.child_hwnd.lock().ok().and_then(|g| *g) {
                Some(c) => c,
                None => return,
            };
            let rect = match engine.last_viewport.lock().ok().and_then(|g| *g) {
                Some(r) => r,
                None => return,
            };
            let parent = match win.hwnd() {
                Ok(h) => h.0 as isize,
                Err(_) => return,
            };
            (child, parent, rect)
        };
        // Hop to the UI thread for SetWindowPos. Can't .await here (this
        // closure isn't async), so just enqueue and move on — the window
        // event bus doesn't wait for us.
        let _ = win.run_on_main_thread(move || {
            let (x, y, w, h) = rect;
            let mut p = POINT { x, y };
            unsafe {
                let _ = ClientToScreen(HWND(parent as *mut _), &mut p);
                let _ = SetWindowPos(
                    HWND(child as *mut _),
                    Some(HWND_TOP),
                    p.x,
                    p.y,
                    w as i32,
                    h as i32,
                    SWP_NOACTIVATE,
                );
            }
        });
    });
    log::info!("[lumina-mpv] window event listener installed");
}

/// Run `work` on the Win32 UI thread that owns `window`. All HWND
/// mutations (CreateWindowExW, SetWindowPos, DestroyWindow) MUST go
/// through this — doing them from a tokio worker clogs the main
/// message pump and freezes the whole app.
#[cfg(target_os = "windows")]
async fn on_main<R, F, T>(window: &tauri::Window<R>, work: F) -> Result<T, String>
where
    R: Runtime,
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::channel();
    window
        .run_on_main_thread(move || {
            let _ = tx.send(work());
        })
        .map_err(|e| format!("run_on_main_thread: {e:?}"))?;
    // tauri::async_runtime wraps tokio and gives us spawn_blocking so
    // the blocking rx.recv() doesn't park a tokio worker thread forever.
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv().map_err(|e| format!("recv: {e}"))
    })
    .await
    .map_err(|e| format!("join: {e}"))??
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn play<R: Runtime>(
    state: tauri::State<'_, MpvEngine>,
    window: tauri::Window<R>,
    url: String,
    opts: Option<PlayOptions>,
) -> Result<(), String> {
    log::info!("[lumina-mpv] play(url={url}, opts={opts:?})");

    let hwnd = window
        .hwnd()
        .map_err(|e| format!("hwnd failed: {e:?}"))?
        .0 as isize;

    // Ensure Mpv exists (first call creates the child HWND on the UI
    // thread). We can't move `state` into the main-thread closure
    // because tauri::State is a short-lived borrow; re-fetch it from
    // the AppHandle instead — the handle is Clone and `MpvEngine` lives
    // in Tauri's state manager for the entire app lifetime.
    let app = window.app_handle().clone();
    on_main(&window, move || {
        let engine = app.state::<MpvEngine>();
        engine.ensure_mpv(hwnd)
    })
    .await?;

    // Install the follow-the-window listener on first play(). Idempotent
    // via the listener_installed flag so repeated play() calls don't
    // stack extra callbacks on the event bus.
    {
        let mut flag = state
            .listener_installed
            .lock()
            .map_err(|e| format!("listener_installed mutex: {e}"))?;
        if !*flag {
            install_window_listener(&window);
            *flag = true;
        }
    }

    // Re-assert Z-order on the UI thread so a user click on React doesn't
    // leave the mpv surface stranded under WebView2.
    let child_raw = state
        .child_hwnd
        .lock()
        .map_err(|e| format!("child_hwnd mutex: {e}"))?
        .ok_or("child HWND missing after ensure_mpv")?;
    on_main(&window, move || {
        unsafe {
            let _ = SetWindowPos(
                HWND(child_raw as *mut _),
                Some(HWND_TOP),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            );
        }
        Ok(())
    })
    .await?;

    let guard = state.mpv.lock().map_err(|e| format!("mutex: {e}"))?;
    let mpv = guard.as_ref().ok_or("mpv not initialized")?;

    if let Some(ref o) = opts {
        if let Some(ref headers) = o.headers {
            if !headers.is_empty() {
                let joined: String = headers
                    .iter()
                    .map(|(k, v)| format!("{k}: {v}"))
                    .collect::<Vec<_>>()
                    .join("\\n");
                let _ = mpv.set_property("http-header-fields", joined.as_str());
            }
        }
    }

    // `start` is an option, not per-file state: mpv keeps whatever we set
    // until it's changed again. Resuming a movie at 20 min and then
    // opening a live channel would start that channel 20 min in (which on
    // a live stream means "fail to open"), so we always write the
    // property — the resume offset when React sent one, "none" otherwise.
    match opts.as_ref().and_then(|o| o.start_time) {
        Some(start) if start > 0.0 => {
            let _ = mpv.set_property("start", format!("{start}").as_str());
        }
        _ => {
            let _ = mpv.set_property("start", "none");
        }
    }

    // Dedup identical consecutive loadfile calls — React Strict Mode
    // double-fires useEffect in dev, which otherwise means every channel
    // click sends loadfile(url, replace) twice in a row. The second
    // "replace" aborts the first mid-handshake and the stream never
    // actually starts; the user saw this as "first channel doesn't play
    // until I switch to another and come back".
    //
    // We compare against our own last_url mutex rather than mpv's `path`
    // property because loadfile is asynchronous internally — path
    // updates lag by a few ms, which is enough for a Strict Mode double
    // call to slip through.
    {
        let mut last = state
            .last_url
            .lock()
            .map_err(|e| format!("last_url mutex: {e}"))?;
        if last.as_deref() == Some(url.as_str()) {
            log::debug!("[lumina-mpv] play() dedup: same URL, skipping loadfile");
            let _ = mpv.set_property("pause", false);
            return Ok(());
        }
        *last = Some(url.clone());
    }

    mpv.command("loadfile", &[url.as_str(), "replace"])
        .map_err(|e| format!("loadfile failed: {e:?}"))?;

    let _ = mpv.set_property("pause", false);

    Ok(())
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn pause(state: tauri::State<'_, MpvEngine>) -> Result<(), String> {
    let guard = state.mpv.lock().map_err(|e| format!("mutex: {e}"))?;
    let mpv = guard.as_ref().ok_or("not playing")?;
    mpv.set_property("pause", true)
        .map_err(|e| format!("pause failed: {e:?}"))
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn resume(state: tauri::State<'_, MpvEngine>) -> Result<(), String> {
    let guard = state.mpv.lock().map_err(|e| format!("mutex: {e}"))?;
    let mpv = guard.as_ref().ok_or("not playing")?;
    mpv.set_property("pause", false)
        .map_err(|e| format!("resume failed: {e:?}"))
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn stop(state: tauri::State<'_, MpvEngine>) -> Result<(), String> {
    let guard = state.mpv.lock().map_err(|e| format!("mutex: {e}"))?;
    let mpv = guard.as_ref().ok_or("not playing")?;
    mpv.command("stop", &[])
        .map_err(|e| format!("stop failed: {e:?}"))
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn seek(state: tauri::State<'_, MpvEngine>, seconds: f64) -> Result<(), String> {
    let guard = state.mpv.lock().map_err(|e| format!("mutex: {e}"))?;
    let mpv = guard.as_ref().ok_or("not playing")?;
    mpv.command("seek", &[&format!("{seconds}"), "absolute"])
        .map_err(|e| format!("seek failed: {e:?}"))
}

// ----------- M5: volume / mute / speed -----------

/// Borrow the live `Mpv` handle for a property or command call.
///
/// Returns `Err("mpv not initialized")` before the first `play()` — the
/// React side fires volume/speed effects on mount, which can land before
/// `ensure_mpv` has run on the UI thread, so every caller over there
/// swallows that error and re-applies once `play()` resolves.
#[cfg(target_os = "windows")]
fn with_mpv<T, F>(state: &tauri::State<'_, MpvEngine>, f: F) -> Result<T, String>
where
    F: FnOnce(&Mpv) -> Result<T, String>,
{
    let guard = state.mpv.lock().map_err(|e| format!("mutex: {e}"))?;
    let mpv = guard.as_ref().ok_or("mpv not initialized")?;
    f(mpv)
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn set_speed(state: tauri::State<'_, MpvEngine>, rate: f64) -> Result<(), String> {
    // The UI only offers 0.5×–2×, but clamp anyway: mpv accepts up to 100×
    // and a bad value from JS would make audio unusable (and, on live
    // streams, run the demuxer cache dry instantly).
    let rate = if rate.is_finite() { rate.clamp(0.25, 4.0) } else { 1.0 };
    with_mpv(&state, |mpv| {
        mpv.set_property("speed", rate)
            .map_err(|e| format!("set speed failed: {e:?}"))
    })
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn set_volume(state: tauri::State<'_, MpvEngine>, vol: u32) -> Result<(), String> {
    // mpv's `volume` is a percentage; with the default volume-max=100
    // anything above 100 is rejected, so clamp rather than error out.
    let vol = vol.min(100) as f64;
    with_mpv(&state, |mpv| {
        mpv.set_property("volume", vol)
            .map_err(|e| format!("set volume failed: {e:?}"))
    })
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn set_mute(state: tauri::State<'_, MpvEngine>, muted: bool) -> Result<(), String> {
    with_mpv(&state, |mpv| {
        mpv.set_property("mute", muted)
            .map_err(|e| format!("set mute failed: {e:?}"))
    })
}

/// Brightness, taken as the UI's multiplier (0.5–2, 1 = untouched) and
/// mapped onto mpv's `brightness` scale (-100…100, 0 = untouched).
///
/// The WebView path does this with a CSS `filter: brightness()` on the
/// `<video>` element, which has no effect at all on the native path —
/// the pixels never go through WebView2's compositor. mpv applies it in
/// the `vo=gpu` shader instead, so it stays free.
#[cfg(target_os = "windows")]
#[tauri::command]
async fn set_brightness(
    state: tauri::State<'_, MpvEngine>,
    multiplier: f64,
) -> Result<(), String> {
    let level = if multiplier.is_finite() {
        ((multiplier - 1.0) * 100.0).clamp(-100.0, 100.0)
    } else {
        0.0
    };
    with_mpv(&state, |mpv| {
        mpv.set_property("brightness", level.round() as i64)
            .map_err(|e| format!("set brightness failed: {e:?}"))
    })
}

/// Move / resize the mpv popup to match the React placeholder.
///
/// React passes the placeholder's bounding rect in **client-area pixels**
/// relative to the Tauri window; we convert to **screen pixels** via
/// ClientToScreen before calling SetWindowPos, because the popup is a
/// top-level window and SetWindowPos on top-level windows uses screen
/// coordinates.
#[cfg(target_os = "windows")]
#[tauri::command]
async fn set_viewport<R: Runtime>(
    state: tauri::State<'_, MpvEngine>,
    window: tauri::Window<R>,
    x: i32,
    y: i32,
    w: u32,
    h: u32,
) -> Result<(), String> {
    let child = state
        .child_hwnd
        .lock()
        .map_err(|e| format!("child_hwnd mutex: {e}"))?
        .ok_or("mpv not initialized yet")?;
    let parent = window
        .hwnd()
        .map_err(|e| format!("hwnd failed: {e:?}"))?
        .0 as isize;

    // Remember the client-area rect so the window-move listener can
    // replay it when the user drags the Lúmina window around. If we
    // skipped this, moving the window would leave the popup sitting
    // over the old screen coords.
    *state
        .last_viewport
        .lock()
        .map_err(|e| format!("last_viewport mutex: {e}"))? = Some((x, y, w, h));

    on_main(&window, move || {
        let mut p = POINT { x, y };
        unsafe {
            // ClientToScreen returns BOOL; failure means invalid HWND.
            // We treat failure as "fall back to raw coords" rather than
            // erroring, so a transient HWND issue doesn't kill playback.
            let _ = ClientToScreen(HWND(parent as *mut _), &mut p);
            SetWindowPos(
                HWND(child as *mut _),
                Some(HWND_TOP),
                p.x,
                p.y,
                w as i32,
                h as i32,
                SWP_NOACTIVATE,
            )
            .map_err(|e| format!("SetWindowPos: {e:?}"))?;
        }
        Ok(())
    })
    .await
}

/// Re-assert Z-order so the mpv child sits above WebView2. Call this
/// whenever React detects it's about to show video (route change, modal
/// close) in case the user clicked on the UI and WebView2 lifted itself
/// over us.
#[cfg(target_os = "windows")]
#[tauri::command]
async fn raise_viewport<R: Runtime>(
    state: tauri::State<'_, MpvEngine>,
    window: tauri::Window<R>,
) -> Result<(), String> {
    let child = state
        .child_hwnd
        .lock()
        .map_err(|e| format!("child_hwnd mutex: {e}"))?
        .ok_or("mpv not initialized yet")?;
    on_main(&window, move || {
        unsafe {
            SetWindowPos(
                HWND(child as *mut _),
                Some(HWND_TOP),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            )
            .map_err(|e| format!("SetWindowPos: {e:?}"))?;
        }
        Ok(())
    })
    .await
}

#[cfg(target_os = "windows")]
#[tauri::command]
async fn hide_viewport<R: Runtime>(
    state: tauri::State<'_, MpvEngine>,
    window: tauri::Window<R>,
) -> Result<(), String> {
    // "Hide" = move off-screen. mpv keeps rendering into the HWND, we
    // just place the surface outside the user's view. Avoids a flashy
    // ShowWindow(HIDE) + the possibility of mpv's internal resize paths
    // trying to deal with 0x0.
    let child = state
        .child_hwnd
        .lock()
        .map_err(|e| format!("child_hwnd mutex: {e}"))?
        .ok_or("mpv not initialized yet")?;

    // Clear last_viewport so the Moved/Resized listener doesn't fight us
    // and drag the popup back on-screen the first time the user moves or
    // resizes the main Lúmina window. Without this, closing the player and
    // then nudging the window makes the (now blank-white, since mpv's
    // vo/gpu has uninit'd) popup pop back where the player used to be.
    *state
        .last_viewport
        .lock()
        .map_err(|e| format!("last_viewport mutex: {e}"))? = None;

    on_main(&window, move || {
        unsafe {
            let _ = SetWindowPos(
                HWND(child as *mut _),
                None,
                -32000,
                -32000,
                0,
                0,
                SWP_NOSIZE | SWP_NOACTIVATE,
            );
        }
        Ok(())
    })
    .await
}

// ----------- M4: tracks + state -----------

/// Read `track-list` through its indexed sub-properties.
///
/// libmpv can hand the whole list back as a single MPV_FORMAT_NODE, but
/// libmpv2 6.x only exposes i64/f64/bool/String getters — so we walk
/// `track-list/count` and read each field individually. Same data, a few
/// more FFI hops, no node-to-serde plumbing to maintain.
///
/// Returns an empty list (not an error) when nothing is loaded yet: React
/// polls this while a channel is still opening and an error there would
/// just be noise.
#[cfg(target_os = "windows")]
#[tauri::command]
async fn get_tracks(state: tauri::State<'_, MpvEngine>) -> Result<Vec<Track>, String> {
    let guard = state.mpv.lock().map_err(|e| format!("mutex: {e}"))?;
    let mpv = match guard.as_ref() {
        Some(m) => m,
        None => return Ok(Vec::new()),
    };
    let count = mpv.get_property::<i64>("track-list/count").unwrap_or(0);
    let mut out = Vec::new();
    for i in 0..count {
        // `type` is "audio" | "video" | "sub". Missing type means the
        // entry vanished between the count read and here (track-list is
        // live) — skip it.
        let kind = match mpv.get_property::<String>(&format!("track-list/{i}/type")) {
            Ok(k) => k,
            Err(_) => continue,
        };
        let id = mpv
            .get_property::<i64>(&format!("track-list/{i}/id"))
            .unwrap_or(-1);
        if id < 0 {
            continue;
        }
        let text = |field: &str| {
            mpv.get_property::<String>(&format!("track-list/{i}/{field}"))
                .ok()
                .filter(|s| !s.is_empty())
        };
        out.push(Track {
            id,
            kind,
            lang: text("lang"),
            title: text("title"),
            codec: text("codec"),
            selected: mpv
                .get_property::<bool>(&format!("track-list/{i}/selected"))
                .unwrap_or(false),
        });
    }

    // Log only when the list actually changes — React polls this every
    // 1.5s and we don't want 40 lines a minute in the dev console. Makes
    // "the audio menu is empty" diagnosable: either mpv really only
    // demuxed one track, or the read path is broken.
    {
        static LAST_SIG: Mutex<Option<String>> = Mutex::new(None);
        let sig = out
            .iter()
            .map(|t| {
                format!(
                    "{}#{}{}",
                    t.kind,
                    t.id,
                    t.lang.as_deref().map(|l| format!("/{l}")).unwrap_or_default()
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        if let Ok(mut last) = LAST_SIG.lock() {
            if last.as_deref() != Some(sig.as_str()) {
                log::info!("[lumina-mpv] track-list ({}): {sig}", out.len());
                *last = Some(sig);
            }
        }
    }

    Ok(out)
}

/// Select an audio track by its mpv track id. A negative id disables
/// audio (`aid=no`).
///
/// We always write the property as a string: `aid` is a choice property
/// ("no" / "auto" / a number), and the string format is the one libmpv
/// converts for every case.
#[cfg(target_os = "windows")]
#[tauri::command]
async fn set_audio_track(state: tauri::State<'_, MpvEngine>, id: i64) -> Result<(), String> {
    let value = if id < 0 { "no".to_string() } else { id.to_string() };
    with_mpv(&state, |mpv| {
        mpv.set_property("aid", value.as_str())
            .map_err(|e| format!("set aid failed: {e:?}"))
    })
}

/// Select a subtitle track by mpv track id; `None` (or a negative id)
/// turns subtitles off.
#[cfg(target_os = "windows")]
#[tauri::command]
async fn set_subtitle_track(
    state: tauri::State<'_, MpvEngine>,
    id: Option<i64>,
) -> Result<(), String> {
    let value = match id {
        Some(i) if i >= 0 => i.to_string(),
        _ => "no".to_string(),
    };
    with_mpv(&state, |mpv| {
        mpv.set_property("sid", value.as_str())
            .map_err(|e| format!("set sid failed: {e:?}"))
    })
}

/// Snapshot of the properties React's control bar needs (position,
/// duration, play/pause, buffering, eof). Polled on an interval instead
/// of wired to mpv's event loop: libmpv2's `wait_event` needs an owned
/// `EventContext`, which we'd have to park on a dedicated thread and
/// bridge back into Tauri's emitter. A 500 ms poll of five properties is
/// cheap and keeps the plugin single-threaded.
///
/// Every read falls back to a default rather than failing: between
/// `loadfile` and the first decoded frame most of these are legitimately
/// "unavailable", which is not an error worth surfacing.
#[cfg(target_os = "windows")]
#[tauri::command]
async fn get_state(state: tauri::State<'_, MpvEngine>) -> Result<PlaybackState, String> {
    let guard = state.mpv.lock().map_err(|e| format!("mutex: {e}"))?;
    let mpv = match guard.as_ref() {
        Some(m) => m,
        None => return Ok(PlaybackState::default()),
    };
    let paused = mpv.get_property::<bool>("pause").unwrap_or(false);
    let idle = mpv.get_property::<bool>("idle-active").unwrap_or(false);
    Ok(PlaybackState {
        playing: !paused && !idle,
        // `paused-for-cache` is mpv's "the network can't keep up" flag;
        // `seeking` covers the gap right after a seek. Either one means
        // React should show the spinner.
        buffering: mpv.get_property::<bool>("paused-for-cache").unwrap_or(false)
            || mpv.get_property::<bool>("seeking").unwrap_or(false),
        position: mpv.get_property::<f64>("time-pos").unwrap_or(0.0),
        // Live streams have no duration — the property errors out and we
        // report 0, which React already treats as "not seekable".
        duration: mpv.get_property::<f64>("duration").unwrap_or(0.0),
        eof: mpv.get_property::<bool>("eof-reached").unwrap_or(false),
    })
}

// ----------- plugin init -----------

#[cfg(target_os = "windows")]
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("lumina-mpv")
        .invoke_handler(tauri::generate_handler![
            play,
            pause,
            resume,
            stop,
            seek,
            set_speed,
            set_volume,
            set_mute,
            set_brightness,
            set_viewport,
            hide_viewport,
            raise_viewport,
            get_tracks,
            set_audio_track,
            set_subtitle_track,
            get_state,
        ])
        .setup(|app, _api| {
            app.manage(MpvEngine::new());
            log::info!("[lumina-mpv] plugin loaded (M1 — libmpv2 with_initializer)");
            Ok(())
        })
        .build()
}

#[cfg(not(target_os = "windows"))]
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("lumina-mpv").build()
}
