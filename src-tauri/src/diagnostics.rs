//! Crash and freeze diagnostics, so a user report comes with evidence.
//!
//! Before this, the app logged through `env_logger` to stderr — and a
//! release build on Windows has no console, so a crash or a freeze left
//! no trace at all. Everything here exists to answer "what happened?"
//! after the fact:
//!
//! - **File log** (`lumina.log`, previous session kept as
//!   `lumina.prev.log`), flushed per line so the last lines before a
//!   crash are on disk.
//! - **Session marker**: written at start, removed on clean exit. If it
//!   is still there on the next launch, the previous session ended
//!   abnormally — crash, freeze-then-force-close, or kill — and the UI
//!   offers to export a report. This catches freezes too, which no crash
//!   handler can.
//! - **Panic hook** (Rust panics) and an **unhandled-exception filter**
//!   (native crashes, i.e. libmpv access violations) that writes a
//!   minidump.
//! - **UI-thread watchdog**: logs when the Win32 message pump stops
//!   responding, which is what a "the app froze" report looks like from
//!   the inside.
//! - **Export**: zips logs + dumps onto the Desktop, with stream
//!   credentials redacted, for the user to send.
//!
//! Stream URLs are redacted everywhere they are written. Xtream URLs
//! carry the account's username and password in the path; the desktop
//! app has already leaked those once through a support screenshot.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant};

use regex::Regex;
use tauri::{AppHandle, Manager, Runtime};

const LOG_FILE: &str = "lumina.log";
const LOG_PREV: &str = "lumina.prev.log";
const SESSION_MARKER: &str = "session.lock";
/// Rotate within a session past this size, so a long-running instance
/// can't fill the disk with a chatty stream.
const MAX_LOG_BYTES: u64 = 20 * 1024 * 1024;

static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();
static PREVIOUS_CRASHED: OnceLock<bool> = OnceLock::new();

/// Same place Tauri's `app_log_dir()` resolves to on Windows
/// (`{LocalAppData}\{identifier}\logs`). Computed by hand because the
/// logger and the crash handlers must be up before the Tauri builder
/// exists — the earliest failures are exactly the ones worth catching.
pub fn log_dir() -> &'static Path {
    LOG_DIR.get_or_init(|| {
        let base = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let dir = base.join("com.luminaplay.app").join("logs");
        let _ = fs::create_dir_all(&dir);
        dir
    })
}

// ---------------------------------------------------------------- redaction

static RE_XTREAM_PATH: LazyLock<Regex> = LazyLock::new(|| {
    // http://host/live/USER/PASS/123.ts  (also movie/, series/)
    Regex::new(r"(/(?:live|movie|series|timeshift)/)[^/\s]+/[^/\s]+/").unwrap()
});
static RE_QUERY_CREDS: LazyLock<Regex> = LazyLock::new(|| {
    // get.php?username=U&password=P  /  player_api.php?username=…
    Regex::new(r"(?i)((?:username|password|pass|user|token)=)[^&\s\x22']+").unwrap()
});
static RE_USERINFO: LazyLock<Regex> = LazyLock::new(|| {
    // http://user:pass@host
    Regex::new(r"(://)[^/\s:@]+:[^/\s@]+@").unwrap()
});

/// Strips stream credentials out of a log line or file.
pub fn redact(text: &str) -> String {
    let s = RE_XTREAM_PATH.replace_all(text, "${1}***/***/");
    let s = RE_QUERY_CREDS.replace_all(&s, "${1}***");
    RE_USERINFO.replace_all(&s, "${1}***:***@").into_owned()
}

// ----------------------------------------------------------------- logger

struct FileLogger {
    file: Mutex<Option<(File, u64)>>,
    level: log::LevelFilter,
}

impl FileLogger {
    fn open_fresh() -> Option<(File, u64)> {
        let dir = log_dir();
        let current = dir.join(LOG_FILE);
        // Keep exactly one previous session: after a crash the user
        // reopens the app, and the interesting log is the one BEFORE that.
        if current.exists() {
            let _ = fs::rename(&current, dir.join(LOG_PREV));
        }
        let f = OpenOptions::new().create(true).append(true).open(&current).ok()?;
        Some((f, 0))
    }
}

impl log::Log for FileLogger {
    fn enabled(&self, meta: &log::Metadata) -> bool {
        meta.level() <= self.level
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let line = redact(&format!(
            "{} {:5} [{}] {}\n",
            timestamp(),
            record.level(),
            record.target(),
            record.args()
        ));
        if let Ok(mut guard) = self.file.lock() {
            let rotate = guard.as_ref().is_some_and(|(_, n)| *n > MAX_LOG_BYTES);
            if rotate {
                *guard = Self::open_fresh();
            }
            if let Some((f, written)) = guard.as_mut() {
                // Flush every line: a native crash gives no chance to
                // flush a buffer, and the last few lines are the point.
                if f.write_all(line.as_bytes()).is_ok() {
                    let _ = f.flush();
                    *written += line.len() as u64;
                }
            }
        }
        #[cfg(debug_assertions)]
        eprint!("{line}");
    }

    fn flush(&self) {}
}

fn timestamp() -> String {
    let now = time::OffsetDateTime::now_local().unwrap_or_else(|_| time::OffsetDateTime::now_utc());
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:03}",
        now.year(),
        now.month() as u8,
        now.day(),
        now.hour(),
        now.minute(),
        now.second(),
        now.millisecond()
    )
}

// ---------------------------------------------------------------- startup

/// Installs the logger and crash handlers and records the session.
/// Call first thing in `run()`, before the Tauri builder.
pub fn init() {
    let logger = FileLogger {
        file: Mutex::new(FileLogger::open_fresh()),
        level: log::LevelFilter::Info,
    };
    // The logger lives for the whole process; leaking it gives `log` the
    // `&'static` it needs without enabling the crate's `std` feature.
    if log::set_logger(Box::leak(Box::new(logger))).is_ok() {
        log::set_max_level(log::LevelFilter::Info);
    }

    // Read the previous session's marker BEFORE writing ours: its
    // presence is the only way to know the last run didn't exit cleanly.
    let marker = log_dir().join(SESSION_MARKER);
    let crashed = marker.exists();
    let _ = PREVIOUS_CRASHED.set(crashed);
    let _ = fs::write(
        &marker,
        format!("pid={} started={}\n", std::process::id(), timestamp()),
    );

    log::info!(
        "=== Lúmina Play {} starting (os={} arch={}) — previous session {} ===",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        if crashed { "ENDED ABNORMALLY" } else { "exited cleanly" }
    );

    install_panic_hook();
    #[cfg(target_os = "windows")]
    native::install();
}

/// Marks the session as having ended cleanly. Call on app exit.
pub fn end_session() {
    log::info!("=== clean exit ===");
    let _ = fs::remove_file(log_dir().join(SESSION_MARKER));
}

fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let backtrace = std::backtrace::Backtrace::force_capture();
        log::error!("PANIC: {info}\n{backtrace}");
        default_hook(info);
    }));
}

/// Native (SEH) crashes: libmpv is C, and an access violation inside it
/// never reaches Rust's panic machinery. Writes a minidump next to the
/// logs, then lets Windows terminate the process as usual.
#[cfg(target_os = "windows")]
mod native {
    use super::{log_dir, timestamp};
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Diagnostics::Debug::{
        MiniDumpNormal, MiniDumpWithThreadInfo, MiniDumpWriteDump, SetUnhandledExceptionFilter,
        EXCEPTION_POINTERS, MINIDUMP_EXCEPTION_INFORMATION,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, GetCurrentProcessId, GetCurrentThreadId};

    const EXCEPTION_CONTINUE_SEARCH: i32 = 0;

    unsafe extern "system" fn on_crash(info: *const EXCEPTION_POINTERS) -> i32 {
        let (code, addr) = unsafe {
            info.as_ref()
                .and_then(|p| p.ExceptionRecord.as_ref())
                .map(|r| (r.ExceptionCode.0 as u32, r.ExceptionAddress as usize))
                .unwrap_or((0, 0))
        };
        log::error!("NATIVE CRASH code=0x{code:08X} address=0x{addr:X} — writing minidump");

        let stamp = timestamp().replace([':', ' ', '.'], "-");
        let path = log_dir().join(format!("crash-{stamp}.dmp"));
        if let Ok(file) = std::fs::File::create(&path) {
            let exc = MINIDUMP_EXCEPTION_INFORMATION {
                ThreadId: unsafe { GetCurrentThreadId() },
                ExceptionPointers: info as *mut EXCEPTION_POINTERS,
                ClientPointers: false.into(),
            };
            // MiniDumpNormal: stacks + module list, small (well under a
            // MB). A full-memory dump would also carry the heap, which
            // holds the user's stream credentials.
            let result = unsafe {
                MiniDumpWriteDump(
                    GetCurrentProcess(),
                    GetCurrentProcessId(),
                    HANDLE(file.as_raw_handle()),
                    MiniDumpNormal | MiniDumpWithThreadInfo,
                    Some(&exc),
                    None,
                    None,
                )
            };
            match result {
                Ok(()) => log::error!("minidump written: {}", path.display()),
                Err(e) => log::error!("minidump failed: {e:?}"),
            }
        }
        EXCEPTION_CONTINUE_SEARCH
    }

    pub fn install() {
        unsafe {
            SetUnhandledExceptionFilter(Some(on_crash));
        }
    }
}

// --------------------------------------------------------------- watchdog

/// Logs when the UI thread stops pumping messages.
///
/// "The app froze" is invisible from inside the frozen thread. This pings
/// the main thread every 2s and complains if the ping isn't answered in
/// 5s — then waits and logs how long the stall lasted, so a report shows
/// both that it froze and right after which action.
pub fn spawn_ui_watchdog<R: Runtime>(app: AppHandle<R>) {
    let _ = std::thread::Builder::new()
        .name("ui-watchdog".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_secs(2));
            let (tx, rx) = std::sync::mpsc::channel::<()>();
            let started = Instant::now();
            if app
                .run_on_main_thread(move || {
                    let _ = tx.send(());
                })
                .is_err()
            {
                break; // event loop gone: app is exiting
            }
            match rx.recv_timeout(Duration::from_secs(5)) {
                Ok(()) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    log::error!("UI THREAD UNRESPONSIVE for 5s+ — app is frozen");
                    if rx.recv().is_ok() {
                        log::warn!(
                            "UI thread recovered after {:.1}s",
                            started.elapsed().as_secs_f32()
                        );
                    } else {
                        break;
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        });
}

// --------------------------------------------------------------- commands

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsStatus {
    previous_session_crashed: bool,
    log_dir: String,
}

#[tauri::command]
pub fn diagnostics_status() -> DiagnosticsStatus {
    DiagnosticsStatus {
        previous_session_crashed: *PREVIOUS_CRASHED.get().unwrap_or(&false),
        log_dir: log_dir().display().to_string(),
    }
}

/// Lets the frontend write into the same log (JS errors, render crashes).
#[tauri::command]
pub fn log_frontend(level: String, message: String) {
    let level = match level.as_str() {
        "error" => log::Level::Error,
        "warn" => log::Level::Warn,
        "debug" => log::Level::Debug,
        _ => log::Level::Info,
    };
    log::log!(target: "frontend", level, "{message}");
}

#[tauri::command]
pub fn open_log_dir<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(log_dir().display().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Zips logs and crash dumps onto the Desktop and reveals the file.
///
/// The Desktop, not the log folder: the person exporting is a viewer
/// who needs to attach one file to a message, not navigate AppData.
/// Text logs are redacted on the way into the zip — our own log is
/// already redacted at write time, but mpv writes its log itself and
/// includes every URL it opens.
#[tauri::command]
pub fn export_diagnostics<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    let desktop = app
        .path()
        .desktop_dir()
        .map_err(|e| format!("desktop: {e}"))?;
    let stamp = timestamp().replace([':', ' ', '.'], "-");
    let zip_path = desktop.join(format!("Lumina-diagnostico-{stamp}.zip"));

    let file = File::create(&zip_path).map_err(|e| format!("create zip: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let dir = log_dir();
    for name in [LOG_FILE, LOG_PREV, "mpv.log", "mpv.prev.log"] {
        let path = dir.join(name);
        if let Ok(bytes) = fs::read(&path) {
            let text = redact(&String::from_utf8_lossy(&bytes));
            zip.start_file(name, opts).map_err(|e| e.to_string())?;
            zip.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        }
    }

    // The three most recent minidumps; older ones are history.
    let mut dumps: Vec<PathBuf> = fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| p.extension().is_some_and(|x| x == "dmp"))
                .collect()
        })
        .unwrap_or_default();
    dumps.sort();
    for path in dumps.iter().rev().take(3) {
        if let (Some(name), Ok(bytes)) = (path.file_name(), fs::read(path)) {
            zip.start_file(name.to_string_lossy(), opts).map_err(|e| e.to_string())?;
            zip.write_all(&bytes).map_err(|e| e.to_string())?;
        }
    }

    let info = format!(
        "Lúmina Play {}\nOS: {} {}\nExportado em: {}\nSessão anterior encerrou de forma anormal: {}\n",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        timestamp(),
        PREVIOUS_CRASHED.get().copied().unwrap_or(false),
    );
    zip.start_file("info.txt", opts).map_err(|e| e.to_string())?;
    zip.write_all(info.as_bytes()).map_err(|e| e.to_string())?;
    zip.finish().map_err(|e| e.to_string())?;

    log::info!("diagnostics exported to {}", zip_path.display());

    use tauri_plugin_opener::OpenerExt;
    let _ = app.opener().reveal_item_in_dir(&zip_path);
    Ok(zip_path.display().to_string())
}
