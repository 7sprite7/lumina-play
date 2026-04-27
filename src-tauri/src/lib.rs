use std::io::Write;
use std::path::PathBuf;
use std::process::Command;

// Lightweight file logger for debugging mpv discovery without needing devtools
// or stdout. Reads via `notepad %TEMP%\lumina-debug.log`.
fn dbg_log(msg: &str) {
    let path = std::env::temp_dir().join("lumina-debug.log");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(f, "[{now}] {msg}");
    }
}

fn sidecar_mpv() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    // In a bundled release Tauri places the sidecar next to the main exe; in
    // `tauri dev` the sidecar is NOT copied automatically, so we also look at
    // the source location relative to target/debug.
    let candidates = [
        dir.join("mpv.exe"),
        dir.join("mpv-x86_64-pc-windows-msvc.exe"),
        dir.join("../../binaries/mpv-x86_64-pc-windows-msvc.exe"),
        dir.join("../../binaries/mpv.exe"),
    ];
    candidates.into_iter().find(|p| p.exists())
}

#[tauri::command]
fn find_mpv() -> Option<String> {
    let exe = std::env::current_exe().ok();
    dbg_log(&format!("find_mpv: current_exe={:?}", exe));

    // 1. Bundled sidecar (preferred — ships with app)
    if let Some(p) = sidecar_mpv() {
        let s = p.to_string_lossy().into_owned();
        dbg_log(&format!("find_mpv: sidecar found at {s}"));
        return Some(s);
    }
    dbg_log("find_mpv: no sidecar");

    // 2. Try PATH via `where mpv`
    if let Ok(output) = Command::new("where").arg("mpv").output() {
        if output.status.success() {
            let s = String::from_utf8_lossy(&output.stdout);
            if let Some(first) = s.lines().next() {
                let trimmed = first.trim();
                if !trimmed.is_empty() {
                    dbg_log(&format!("find_mpv: PATH found at {trimmed}"));
                    return Some(trimmed.to_string());
                }
            }
        }
    }

    // 3. Common Windows install paths
    let candidates = [
        r"C:\Program Files\mpv\mpv.exe",
        r"C:\Program Files (x86)\mpv\mpv.exe",
        r"C:\mpv\mpv.exe",
    ];
    for c in candidates {
        let p = PathBuf::from(c);
        if p.exists() {
            dbg_log(&format!("find_mpv: install path found at {c}"));
            return Some(c.to_string());
        }
    }

    dbg_log("find_mpv: NOT FOUND");
    None
}

#[tauri::command]
fn is_mpv_installed() -> bool {
    find_mpv().is_some()
}

#[tauri::command]
fn open_in_mpv(url: String, title: String) -> Result<(), String> {
    let mpv = find_mpv().ok_or_else(|| "mpv não encontrado. Instale pelo site mpv.io".to_string())?;

    let mut cmd = Command::new(&mpv);
    cmd.arg(&url)
        .arg(format!("--title={}", title))
        .arg("--force-window=yes")
        .arg("--keep-open=yes");

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.spawn().map_err(|e| format!("Falha ao abrir mpv: {}", e))?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            find_mpv,
            is_mpv_installed,
            open_in_mpv,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
