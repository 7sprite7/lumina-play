// `native` = HTML5 <video> src=url path (iOS Safari, direct MP4 playback).
// `mpv`    = native libmpv popup via tauri-plugin-lumina-mpv (desktop
//            Windows build only). Added when we pivoted away from
//            WebView2's MSE for live streams in v0.2.0 — see
//            tauri-plugin-lumina-mpv/README.md.
export type Engine = "hls" | "mpegts" | "native" | "mpv";

export function selectEngine(url: string, kind: "live" | "vod"): Engine {
  const clean = url.split("?")[0].toLowerCase();
  if (/\.m3u8$/.test(clean)) return "hls";
  if (/\.(ts|flv)$/.test(clean)) return "mpegts";
  if (/\.(mp4|mkv|webm|avi|mov)$/.test(clean)) return "native";
  // Sem extensão: live = mpegts (formato Xtream raw), VOD = native
  return kind === "live" ? "mpegts" : "native";
}
