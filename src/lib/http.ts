// HTTP fetcher with platform fallback.
//
// In Tauri we use `@tauri-apps/plugin-http` because it issues the request
// from the native (Rust) side and is therefore not subject to browser CORS
// restrictions — most IPTV providers don't send `Access-Control-Allow-*`
// headers, so a direct browser `fetch` would be blocked.
//
// In the web build we fall back to the browser `fetch`. CORS is an inherent
// limitation there: the deployment is expected to either (a) sit behind a
// CORS-aware reverse proxy (Caddy / nginx / Cloudflare Worker) on the same
// VPS that hosts the static bundle, or (b) accept that some sources will
// not load. Either way, the fetch logic itself doesn't change — it's just
// the network path that's different.

import { IS_TAURI } from "./platform";

export async function fetchText(url: string): Promise<string> {
  if (IS_TAURI) {
    // Lazy-load to keep the Tauri plugin out of the web bundle.
    const { fetch: tFetch } = await import("@tauri-apps/plugin-http");
    const res = await tFetch(url, { method: "GET" });
    if (!res.ok) throw new Error(`HTTP ${res.status} ao buscar ${url}`);
    return await res.text();
  }
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) throw new Error(`HTTP ${res.status} ao buscar ${url}`);
  return await res.text();
}
