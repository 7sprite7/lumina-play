import type { Source, XtreamSource } from "../types";

// Many providers expose a single playlist URL of the form
//   http(s)://host[:port]/get.php?username=X&password=Y[&type=...]
// which is actually an Xtream Codes panel exporting itself as M3U. Hitting the
// Xtream `player_api.php` endpoints with the same credentials gives us much
// richer metadata (proper covers, plots, cast, ratings) than the bare M3U.
//
// This helper extracts the Xtream credentials from such a URL so the loader
// can transparently switch to the Xtream API when available.
export function detectXtreamFromM3UUrl(
  url: string
): { host: string; username: string; password: string } | null {
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();
    // Most common: /get.php  (some panels also expose /xmltv.php — same creds)
    if (!/\/(get|xmltv|player_api)\.php$/.test(path)) return null;
    const username = u.searchParams.get("username");
    const password = u.searchParams.get("password");
    if (!username || !password) return null;
    return {
      host: `${u.protocol}//${u.host}`,
      username,
      password,
    };
  } catch {
    return null;
  }
}

// Returns the effective XtreamSource for a given source: either the source
// itself (if it's already Xtream) or one derived from an Xtream-flavored M3U
// URL. Returns null if the source can't be queried as Xtream.
export function effectiveXtreamSource(source: Source): XtreamSource | null {
  if (source.type === "xtream") return source;
  if (source.type === "m3u") {
    const creds = detectXtreamFromM3UUrl(source.url);
    if (!creds) return null;
    return {
      id: source.id,
      type: "xtream",
      name: source.name,
      ...creds,
    };
  }
  return null;
}
