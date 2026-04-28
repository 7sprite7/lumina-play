// Generic HTTP(S) → CORS proxy URL rewriter.
//
// Why this exists:
//
// IPTV providers serve their catalog API on one host (e.g. vsplay.fun) but
// stream the actual media from a different host (block.appnmd.top, CDN
// nodes, etc.) — and almost none of them send `Access-Control-Allow-*`
// headers. From a browser running on https://yourdomain that means every
// fetch to any of those hosts is blocked.
//
// To make the web build work without hardcoding each upstream in the
// reverse-proxy server, the deployment exposes a single generic CORS
// proxy at:
//
//     /proxy/<scheme>/<host>:<port>/<rest-of-path>
//
// Caddy (or any reverse proxy) captures host, port and scheme from the
// path, forwards the request to <scheme>://<host>:<port>/<rest>, and adds
// CORS headers on the response.
//
// `proxify(url)` rewrites an upstream URL into the proxied form.
// It's a no-op when:
//   - We're running on Tauri (`IS_TAURI` — has its own native HTTP path).
//   - The current page is HTTP (e.g. localhost dev) — no CORS to bypass.
//   - The URL is already same-origin / a relative path.
//
// Usage:
//
//     import { proxify } from "./lib/proxy";
//     const r = await fetch(proxify(originalUrl));
//
// ⚠️  This is intentionally an OPEN proxy: any host the user types in
// will be relayed. For a public deployment, the operator should put
// the proxy behind an auth wall (Caddy basicauth or app-level login).

import { IS_TAURI } from "./platform";

export function proxify(url: string): string {
  if (IS_TAURI) return url;
  if (typeof window === "undefined") return url;
  // No need to proxy on plain HTTP — there's no CORS to bypass when the
  // page is itself loaded over HTTP.
  if (window.location.protocol !== "https:") return url;
  if (!url) return url;
  if (!url.startsWith("http:") && !url.startsWith("https:")) return url;

  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }

  // Same-origin — already proxified, or pointing to the SPA itself. No-op.
  if (u.host === window.location.host) return url;

  const scheme = u.protocol.replace(":", "");
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  return `${window.location.origin}/proxy/${scheme}/${u.host}:${port}${u.pathname}${u.search}`;
}
