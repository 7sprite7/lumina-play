export type Engine = "hls" | "mpegts" | "native";

export function selectEngine(url: string, kind: "live" | "vod"): Engine {
  const clean = url.split("?")[0].toLowerCase();
  if (/\.m3u8$/.test(clean)) return "hls";
  if (/\.(ts|flv)$/.test(clean)) return "mpegts";
  if (/\.(mp4|mkv|webm|avi|mov)$/.test(clean)) return "native";
  // Sem extensão: live = mpegts (formato Xtream raw), VOD = native
  return kind === "live" ? "mpegts" : "native";
}
