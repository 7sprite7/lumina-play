// Typed thin wrappers around the `tauri-plugin-lumina-mpv` Rust plugin.
//
// Only the Tauri desktop build on Windows ships the plugin — the web build
// and (for now) Linux / macOS fall back to mpegts.js / hls.js inside the
// WebView. The exported `hasNativeMpv` flag lets `Player.tsx` branch at
// mount time; each command below is a no-op resolved promise when the
// plugin isn't available so callers can invoke them unconditionally
// without blowing up outside Windows Tauri.

import { IS_TAURI } from "./platform";

/** True when the native mpv plugin is available. False in the web build
 *  and on non-Windows Tauri targets (where we don't compile the plugin). */
export const hasNativeMpv =
  IS_TAURI &&
  typeof navigator !== "undefined" &&
  /Windows/i.test(navigator.userAgent);

/** mpv.command("loadfile") options we expose to callers. */
export interface PlayOptions {
  /** Extra HTTP headers mpv should send on the stream request (Referer,
   *  User-Agent, etc.). Leave undefined for direct playback. */
  headers?: Record<string, string>;
  /** VOD only — resume at this timestamp (seconds). */
  startTime?: number;
}

// Lazy invoke so we don't crash in a plain-browser environment where
// `__TAURI_INTERNALS__` isn't defined. The `window as any` cast keeps
// TypeScript happy without needing to depend on @tauri-apps/api just for
// one function.
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!hasNativeMpv) {
    return Promise.resolve(undefined as T);
  }
  const internals = (window as unknown as {
    __TAURI_INTERNALS__?: {
      invoke: <R>(cmd: string, args?: Record<string, unknown>) => Promise<R>;
    };
  }).__TAURI_INTERNALS__;
  if (!internals) return Promise.resolve(undefined as T);
  return internals.invoke<T>(`plugin:lumina-mpv|${cmd}`, args);
}

// ---------- transport ----------

export async function play(url: string, opts?: PlayOptions): Promise<void> {
  // Pre-resolve HTTP 302 redirects before handing the URL to mpv. Many
  // IPTV panels (vsplay.fun, most Xtream behind Cloudflare) issue a
  // short-lived CDN redirect — mpv's built-in curl backend sees
  // `Content-Type: text/html` on that response and aborts before
  // following. Doing it here, through tauri-plugin-http (bypasses the
  // CORS layer and follows redirects transparently), hands mpv the
  // already-resolved CDN URL and sidesteps the issue entirely.
  //
  // Only try to resolve http(s). Skip other schemes (`file://`, etc.)
  // untouched. Any error here falls back to the original URL — the
  // native engine may still be able to play it directly.
  let finalUrl = url;
  if (hasNativeMpv && /^https?:/i.test(url)) {
    try {
      const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
      const r = await tauriFetch(url, {
        method: "HEAD",
        headers: {
          "User-Agent": "VLC/3.0.20 LibVLC/3.0.20",
          ...(opts?.headers ?? {}),
        },
        redirect: "follow",
      });
      // response.url holds the final URL after any redirects.
      if (r.url && r.url !== url) {
        finalUrl = r.url;
      }
    } catch (e) {
      // Network error, 404 on HEAD, DNS failure — leave URL as-is and
      // let mpv try. We've seen some providers 405 on HEAD but 200 on
      // GET, so falling through is the safe default.
      console.warn("[native-mpv] redirect pre-resolve failed:", e);
    }
  }
  return invoke<void>("play", { url: finalUrl, opts });
}

export function pause(): Promise<void> {
  return invoke<void>("pause");
}

export function resume(): Promise<void> {
  return invoke<void>("resume");
}

export function stop(): Promise<void> {
  return invoke<void>("stop");
}

export function seek(seconds: number): Promise<void> {
  return invoke<void>("seek", { seconds });
}

// ---------- audio / rate ----------
//
// These map 1:1 onto mpv properties (`volume`, `mute`, `speed`). They
// reject with "mpv not initialized" if called before the first `play()`
// resolves — the Player re-applies all three right after play() for
// exactly that reason, so callers can ignore the rejection.

/** Volume as a percentage, 0–100 (mpv's own scale, not the 0–1 the
 *  `<video>` element uses — the Player converts). */
export function setVolume(volume: number): Promise<void> {
  const vol = Math.max(0, Math.min(100, Math.round(volume)));
  return invoke<void>("set_volume", { vol });
}

export function setMute(muted: boolean): Promise<void> {
  return invoke<void>("set_mute", { muted });
}

export function setSpeed(rate: number): Promise<void> {
  return invoke<void>("set_speed", { rate });
}

/** Brightness as the UI's multiplier (0.5–2, 1 = untouched). The plugin
 *  maps it onto mpv's -100…100 `brightness` scale — the CSS filter the
 *  WebView path uses can't touch mpv's own surface. */
export function setBrightness(multiplier: number): Promise<void> {
  return invoke<void>("set_brightness", { multiplier });
}

// ---------- viewport ----------
//
// `set_viewport(x, y, w, h)` positions and sizes the mpv popup where it
// should appear inside the Tauri window. Coordinates are **client-area
// pixels** of the main window (what React naturally gets from
// `getBoundingClientRect()`); the plugin converts to screen coords for us.

export function setViewport(x: number, y: number, w: number, h: number): Promise<void> {
  // SetWindowPos refuses zero-size, and the mpv render path doesn't like
  // being asked to draw into a 0x0 surface either — just hide instead.
  if (w <= 0 || h <= 0) return hideViewport();
  return invoke<void>("set_viewport", {
    x: Math.round(x),
    y: Math.round(y),
    w: Math.round(w),
    h: Math.round(h),
  });
}

export function hideViewport(): Promise<void> {
  return invoke<void>("hide_viewport");
}

export function raiseViewport(): Promise<void> {
  return invoke<void>("raise_viewport");
}

// ---------- introspection ----------

export interface Track {
  /** mpv track id — what `aid` / `sid` expect, 1-based per track type. */
  id: number;
  /** mpv's own naming: "audio" | "video" | "sub". */
  kind: "audio" | "sub" | "video" | string;
  lang?: string;
  title?: string;
  codec?: string;
  selected: boolean;
}

export interface PlaybackState {
  playing: boolean;
  buffering: boolean;
  position: number;
  duration: number;
  /** mpv's `eof-reached`: the file ran to the end and is parked on the
   *  last frame (we run with `keep-open=yes`). The native path has no
   *  `<video>` `ended` event, so this is what drives auto-next-episode. */
  eof: boolean;
}

export function getTracks(): Promise<Track[]> {
  if (!hasNativeMpv) return Promise.resolve([]);
  return invoke<Track[]>("get_tracks");
}

export function setAudioTrack(id: number): Promise<void> {
  return invoke<void>("set_audio_track", { id });
}

export function setSubtitleTrack(id: number | null): Promise<void> {
  return invoke<void>("set_subtitle_track", { id });
}

export function getState(): Promise<PlaybackState> {
  if (!hasNativeMpv) {
    return Promise.resolve({
      playing: false,
      buffering: false,
      position: 0,
      duration: 0,
      eof: false,
    });
  }
  return invoke<PlaybackState>("get_state");
}
