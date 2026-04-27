import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// Detect Tauri builds vs plain web builds. Tauri sets TAURI_PLATFORM /
// TAURI_ENV_* env vars when invoking the build. We disable the PWA plugin in
// Tauri so the desktop app doesn't end up with a service worker that would
// conflict with the WebView2 cache.
// @ts-expect-error process is a nodejs global
const isTauri = !!process.env.TAURI_ENV_PLATFORM || !!process.env.TAURI_PLATFORM;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    react(),
    ...(isTauri
      ? []
      : [
          VitePWA({
            registerType: "autoUpdate",
            // Asset list: anything in public/ that the PWA layer should
            // fingerprint into the precache manifest.
            includeAssets: [
              "lumina-logo.png",
              "lumina-bg.png",
              "apple-touch-icon.png",
            ],
            manifest: {
              name: "Lúmina Play",
              short_name: "Lúmina",
              description:
                "Personal IPTV player — live TV, movies and series.",
              theme_color: "#0c0e16",
              background_color: "#0c0e16",
              display: "standalone",
              orientation: "any",
              start_url: "/",
              scope: "/",
              lang: "pt-BR",
              icons: [
                {
                  src: "/pwa-192x192.png",
                  sizes: "192x192",
                  type: "image/png",
                  purpose: "any",
                },
                {
                  src: "/pwa-512x512.png",
                  sizes: "512x512",
                  type: "image/png",
                  purpose: "any",
                },
                {
                  src: "/pwa-maskable-512x512.png",
                  sizes: "512x512",
                  type: "image/png",
                  // "maskable": Android's adaptive-icon shapes (circle / squircle)
                  // crop to ~80% of the canvas — this version has padding so the
                  // logo isn't cut off.
                  purpose: "maskable",
                },
              ],
            },
            workbox: {
              // Precache the SPA shell (HTML/CSS/JS/images bundled by Vite).
              // Streams and IPTV API responses are intentionally NOT cached
              // — they go straight to the network so the user always gets
              // a fresh stream URL and current EPG/catalog.
              globPatterns: ["**/*.{js,css,html,ico,png,svg,webp}"],
              // The main JS bundle is ~1.1MB. Default warning threshold is 2MB
              // — bump just in case the bundle grows.
              maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
              navigateFallback: "/index.html",
              // Anything that looks like an IPTV stream/API endpoint should
              // bypass the SW entirely.
              navigateFallbackDenylist: [
                /^\/proxy\//,
                /\.m3u8?$/i,
                /\.ts$/i,
                /\.mp4$/i,
                /\.mkv$/i,
                /player_api\.php/i,
                /get\.php/i,
                /xmltv\.php/i,
              ],
              runtimeCaching: [],
            },
            devOptions: {
              // Enable PWA in dev so you can test install locally
              // (http://localhost:1420 with `npm run dev:web`).
              enabled: true,
              type: "module",
            },
          }),
        ]),
  ],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
