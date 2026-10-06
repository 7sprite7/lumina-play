# tauri-plugin-lumina-mpv

Native libmpv engine for Lúmina Play **desktop** (Windows). Replaces the
`mpegts.js` / `hls.js` fallback inside WebView2 for the Tauri build. The
web build served from the VPS continues to use the browser engines.

Mirror of the Android `tauri-plugin-lumina-player` on branch `mobile/android`
— same command surface, different runtime. `Player.tsx` dispatches by
platform at the top.

## Status

**M0 — scaffold only.** All commands are stubs that return
`Err("not implemented")`. The JS side can start wiring invokes against the
final API shape.

See [`../../scratchpad/native-player-plan.md`](the plan) for the milestones
and risks list.

## API surface

| Command                | Purpose                                   |
| ---------------------- | ----------------------------------------- |
| `play(url, opts?)`     | Start a stream. `opts.headers` for UA/Ref |
| `pause / resume / stop`| Transport                                 |
| `seek(seconds)`        | VOD only                                  |
| `set_speed(rate)`      | VOD only, 0.5..2                          |
| `set_volume(0..100)`   | Volume                                    |
| `set_mute(bool)`       | Mute                                      |
| `set_viewport(x,y,w,h)`| Where mpv renders inside the Tauri window |
| `hide_viewport()`      | Called when the player closes             |
| `get_tracks()`         | Audio / subtitle / video track list       |
| `set_audio_track(id)`  | **Resolves dual audio**                   |
| `set_subtitle_track(id)` | `null` = off                            |
| `get_state()`          | `{playing, buffering, position, duration}` |

Events emitted on the global Tauri event bus:

| Event                 | Payload                                   |
| --------------------- | ----------------------------------------- |
| `lumina-mpv:state`    | `PlaybackState`                           |
| `lumina-mpv:tracks`   | `Track[]`                                 |
| `lumina-mpv:ended`    | `{}`                                      |
| `lumina-mpv:error`    | `{code, message}` — generic for the user  |

## Build-time setup

The crate links against `libmpv-2.lib` on Windows. Run the download script
from the repo root before the first `cargo build`:

```powershell
pwsh scripts/download-libmpv.ps1
```

It drops the DLL at `src-tauri/binaries/libmpv-2.dll` (resource shipped with
the app) and the import library at `src-tauri/binaries/lib/libmpv-2.lib`
(for `rustc` to link against). The folders are `.gitignore`d — every dev
and the build server re-fetch.

## Non-Windows targets

The main app's `Cargo.toml` depends on this plugin only under
`[target.'cfg(target_os = "windows")'.dependencies]`. On Linux / macOS the
plugin never compiles and `Player.tsx` falls back to `mpegts.js` / `hls.js`
via the existing `IS_TAURI` branch — same as the web build.
