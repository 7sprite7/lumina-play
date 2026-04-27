# Lúmina Play

Personal IPTV player. Same React + TypeScript codebase ships as a **Tauri**
desktop app (Windows / planned macOS / Linux) **and** a static **web build**
for self-hosted VPS deployment.

- **Stack:** Tauri 2 · React 19 · TypeScript · Vite · Tailwind v3 · Zustand · react-virtuoso · hls.js · mpegts.js
- **Storage:**
  - desktop → `LazyStore` (`%APPDATA%\com.luminaplay.app\iptv-player.json`) + filesystem cache
  - web → `localStorage` (config) + IndexedDB (catalog cache)
- **Network:**
  - desktop → `tauri-plugin-http` (no CORS, runs from Rust)
  - web → browser `fetch` (CORS applies — see [Reverse proxy](#3-reverse-proxy-and-cors) below)

The runtime detects which platform it's on via `__TAURI_INTERNALS__` and forks
the I/O paths automatically — there's no separate web branch.

---

## Quick start

### Prerequisites

- Node 18+ and npm
- For the desktop build: Rust stable + the Tauri prerequisites
  ([tauri.app/start/prerequisites](https://tauri.app/start/prerequisites/))

```bash
git clone https://github.com/7sprite7/lumina-play.git
cd lumina-play
npm install
```

### Desktop (development)

```bash
npm run tauri dev
```

### Desktop (release build)

```bash
npm run tauri build
```

Outputs in `src-tauri/target/release/bundle/`:

- NSIS installer: `nsis/Lúmina Play_<version>_x64-setup.exe`
- MSI installer:  `msi/Lúmina Play_<version>_x64_en-US.msi`

### Web (development)

```bash
npm run dev:web
# http://localhost:1420
```

### Web (production build)

```bash
npm run build:web
# → dist/  (static files, ready to serve)
```

The `dist/` directory is the entire web app. Drop it on any static host.

---

## VPS deployment

The web build is plain static HTML + JS + CSS, so any static server works
(Caddy, nginx, Apache, even `python -m http.server`). The only thing the
deploy needs to think about is **CORS**, because IPTV providers almost never
send `Access-Control-Allow-*` headers — so the browser blocks direct fetches
to them. The fix is a tiny reverse proxy on the same VPS.

### 1. Build locally

```bash
npm run build:web
```

### 2. Push the bundle to the VPS

```bash
rsync -av --delete dist/ user@vps:/var/www/lumina-play/
```

(Or `scp -r dist/* user@vps:/var/www/lumina-play/`. Whatever you prefer.)

### 3. Reverse proxy and CORS

Two cases:

#### A. Your IPTV provider already sends CORS headers

Lucky. Just serve `dist/` and you're done. Test by opening DevTools → Network
and confirming a request to `/player_api.php?...` succeeds with a
`Access-Control-Allow-Origin: *` (or your domain) response header.

#### B. The provider does NOT send CORS headers (the common case)

You need a reverse proxy that forwards the request and adds the CORS header
itself. The web app is configured to call the provider URL directly — you
have two ways to make that work:

**Option 1 — Same-origin proxy** (simplest, no app config changes needed): mount the
provider's host under your own domain so the browser never sees a cross-origin
request.

Caddy example (`/etc/caddy/Caddyfile`):

```caddy
lumina.seudominio.com {
    encode zstd gzip

    # SPA: serve static files, fall through to index.html for client-side
    # routes (the app uses hash routing internally, but this future-proofs it)
    root * /var/www/lumina-play
    try_files {path} /index.html
    file_server

    # CORS-enabled passthrough for the IPTV API + streams.
    # Match /proxy/<host>/<rest> → http://<host>/<rest>
    @proxy path /proxy/*
    handle @proxy {
        rewrite * /{re.proxy.1}
        reverse_proxy https://{re.proxy.0} {
            header_up Host {upstream_hostport}
        }
        header Access-Control-Allow-Origin *
        header Access-Control-Allow-Headers *
    }
}
```

This requires the app to rewrite source URLs to `/proxy/<host>/...` — see
[Open question](#open-question) below.

**Option 2 — Per-source backend proxy** (most flexible): point each Xtream/M3U
source URL directly at a small Node/Express proxy you write yourself. Easiest
when you have a few known providers. Example proxy:

```js
// proxy.js
import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";

const app = express();
app.use("/p", createProxyMiddleware({
  target: process.env.UPSTREAM, // e.g. http://provider.example.com:8080
  changeOrigin: true,
  onProxyRes: (proxyRes) => {
    proxyRes.headers["Access-Control-Allow-Origin"] = "*";
  },
}));
app.listen(3001);
```

Then in the Lúmina app, register the **proxied URL** as your source
(`http://lumina.seudominio.com/p/...`) instead of the upstream.

#### Nginx alternative

If you prefer nginx over Caddy:

```nginx
server {
    listen 443 ssl http2;
    server_name lumina.seudominio.com;
    ssl_certificate     /etc/letsencrypt/live/lumina.seudominio.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/lumina.seudominio.com/privkey.pem;

    root /var/www/lumina-play;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # CORS-enabled proxy. Same idea as the Caddy block above.
    location ~ ^/proxy/([^/]+)/(.*)$ {
        proxy_pass http://$1/$2$is_args$args;
        proxy_set_header Host $1;
        add_header Access-Control-Allow-Origin *;
        add_header Access-Control-Allow-Headers *;
    }
}
```

### 4. Streaming format support on web

Live IPTV streams typically come in three transport types:

| Format | Browser support |
|---|---|
| HLS (`.m3u8`) | Yes via `hls.js` (already bundled) |
| MPEG-TS (`.ts` / bare URLs) | Yes via `mpegts.js` (already bundled) |
| Native MP4 / MKV (VOD) | Yes via the `<video>` tag |

Both `.m3u8` and bare `.ts` streams must still pass the CORS check above.
Audio/subtitle track switching for MKV files is not possible in the browser
— that's a desktop-only feature (it's why the desktop build ships an
optional mpv sidecar; web users get the in-browser `<video>` element with
whatever the source provides).

### Open question

The reverse-proxy "Option 1" above assumes the app rewrites IPTV URLs to
`/proxy/<host>/...`. The current code uses the source URL as-is — that works
fine when the provider has CORS, when running through Tauri (no CORS), or
when you use "Option 2". If your VPS deployment relies on "Option 1", you
will need either:

- Register sources in the app with the already-rewritten `/proxy/...` URL, or
- Add a build-time rewrite hook (TODO — not implemented yet)

For now the simplest path is **Option 2**: stick a transparent proxy on a
dedicated path/subdomain and register that proxied URL as the source.

---

## Project layout

```
src/
├── App.tsx                        Root component, view routing
├── store.ts                       Zustand store (state + actions)
├── types.ts                       Shared TS types
├── components/                    React components
│   ├── Player.tsx                 Video player + episode prompt + controls
│   ├── Browser.tsx                Live/Movies/Series grid
│   ├── Sidebar.tsx                Category list with virtual categories
│   ├── SeriesDetail.tsx, MovieDetail.tsx
│   └── ...
└── lib/
    ├── platform.ts                IS_TAURI / IS_WEB detection
    ├── kv.ts                      Key/value abstraction (LazyStore vs localStorage)
    ├── cache.ts                   Catalog cache (fs vs IndexedDB)
    ├── http.ts                    HTTP fetcher (tauri-plugin-http vs fetch)
    ├── mpv.ts                     Mpv invocation (no-op on web)
    ├── search.ts                  Custom fuzzy search index (typo-tolerant)
    ├── m3u-parser.ts, xtream-api.ts
    ├── playback-engine.ts         Engine selector (HLS / MPEG-TS / native)
    ├── adult-detector.ts, virtual-categories.ts, ...
    └── i18n.ts                    PT / EN dictionaries

src-tauri/
├── src/lib.rs                     Tauri commands (find_mpv, open_in_mpv, ...)
├── capabilities/default.json      Tauri permission scopes
├── tauri.conf.json
└── Cargo.toml
```

---

## Features

- Live TV, Movies, Series — Xtream Codes API + plain M3U sources
- Auto-detect of M3U URLs that follow the Xtream `/get.php?...` flavour, then
  switches to the Xtream API to enrich posters/plot/cast/rating
- Continue Watching (movies + series with episode-level progress)
- Live "Recently watched" + favourite live channels
- Series episode auto-advance with a Netflix-style end-of-video prompt
  (10 s countdown, "Cancel" / "Play now" actions). Hotkeys: `N` / `P`.
- Per-episode watched-time progress bar in series detail
- Adult content protection (PIN, SHA-256 hashed)
- Smart typo-tolerant search (custom — no external lib, scales to 22k+ items)
- i18n PT-BR / EN; classic and modern themes; configurable date / time formats
- Live category order preserved from source M3U/Xtream (no count-based re-rank)
- Adult categories always pushed to the end of the sidebar list

### Desktop-only

- Optional mpv sidecar (~115 MB, bundled in installer) — "Open in mpv"
  button for full multi-audio / subtitle support on MKV files
- Cache survives reinstall (`%APPDATA%\com.luminaplay.app\cache\`)
- No CORS limitations (HTTP via `tauri-plugin-http`)

---

## License

Personal project. No license attached — all rights reserved.
