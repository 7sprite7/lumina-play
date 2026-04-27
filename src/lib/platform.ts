// Runtime platform detection.
//
// Tauri injects `__TAURI_INTERNALS__` into `window` before the bundle runs.
// In a regular browser it's absent, so a single boolean cleanly tells us
// whether we have access to the native plugins (fs, store, http, opener,
// custom invoke commands).
//
// Use this anywhere you need to fork between native (Tauri desktop) and web
// (vanilla browser) behaviour: storage backends, HTTP clients, mpv buttons,
// etc.

export const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const IS_WEB = !IS_TAURI;
