import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Hls from "hls.js";
import mpegts from "mpegts.js";
import type { Episode } from "../types";
import { useAppStore, findEpisodeNeighbors } from "../store";
import { selectEngine, type Engine } from "../lib/playback-engine";
import { IS_TAURI } from "../lib/platform";
import * as nativeMpv from "../lib/native-mpv";
import { proxify } from "../lib/proxy";
import { useT } from "../lib/i18n";
import {
  IconBrightness,
  IconSpeed,
  IconCaptions,
  IconCheck,
  IconClose,
  IconCopy,
  IconFullscreen,
  IconLanguage,
  IconPause,
  IconPip,
  IconPlay,
  IconRetry,
  IconSkipBack,
  IconSkipForward,
  IconVolume,
  IconVolumeMute,
} from "./icons";

interface Track {
  id: number;
  label: string;
  lang?: string;
}

function formatTime(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return "--:--";
  const total = Math.floor(secs);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatEpgTime(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export default function Player() {
  const playback = useAppStore((s) => s.playback);
  const stop = useAppStore((s) => s.stopPlayback);
  const watchProgress = useAppStore((s) => s.watchProgress);
  const saveProgress = useAppStore((s) => s.saveProgress);
  const clearProgress = useAppStore((s) => s.clearProgress);
  const nextLive = useAppStore((s) => s.nextLive);
  const prevLive = useAppStore((s) => s.prevLive);
  const nextEpisodeAction = useAppStore((s) => s.nextEpisode);
  const prevEpisodeAction = useAppStore((s) => s.prevEpisode);
  const liveQueue = useAppStore((s) => s.liveQueue);
  const liveQueueIndex = useAppStore((s) => s.liveQueueIndex);
  const currentEpg = useAppStore((s) => s.currentEpg);
  const epgLoading = useAppStore((s) => s.epgLoading);
  const showEpgSetting = useAppStore((s) => s.settings.showEpg);
  const videoBrightness = useAppStore((s) => s.settings.videoBrightness);
  const updateSettings = useAppStore((s) => s.updateSettings);
  // Subscribe to the raw `series` array (stable reference until the catalog
  // changes) and derive neighbours via useMemo. Returning a fresh object from
  // a Zustand selector on every store tick would defeat ref-equality and
  // cause useSyncExternalStore to flag "getSnapshot should be cached" plus
  // re-render loops — observed as a black screen.
  const seriesList = useAppStore((s) => s.series);
  const t = useT();

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // When the native mpv engine is used, the OS composites a top-level
  // popup over this element — so our React overlays (close button,
  // play/pause, SeekBar) would be hidden if the popup covered the whole
  // stage. `videoAreaRef` is the strict rect the mpv popup is pinned to;
  // we shrink it to leave `TOP_BAR_H` / `BOTTOM_BAR_H` strips at the
  // edges whenever the controls are visible so they stay on top of the
  // video. When controls auto-hide, the area expands back to fill the
  // stage. On the web/WebView engines the `<video>` fills its parent
  // and overlays naturally sit above it, so this layer is a no-op there.
  const videoAreaRef = useRef<HTMLDivElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const mpegtsRef = useRef<mpegts.Player | null>(null);

  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [error, setError] = useState<string | null>(null);
  const [isPip, setIsPip] = useState(false);
  const [loading, setLoading] = useState(true);
  const [attemptCount, setAttemptCount] = useState(0);
  const [engineUsed, setEngineUsed] = useState<Engine | null>(null);
  const [copied, setCopied] = useState(false);

  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const [audioTracks, setAudioTracks] = useState<Track[]>([]);
  const [currentAudio, setCurrentAudio] = useState<number | null>(null);
  const [subtitleTracks, setSubtitleTracks] = useState<Track[]>([]);
  const [currentSubtitle, setCurrentSubtitle] = useState<number>(-1);

  const [menu, setMenu] = useState<"audio" | "sub" | "brightness" | "speed" | null>(null);
  // VOD-only playback speed. Resets to 1× whenever a new item starts (see
  // the useEffect on playback?.itemId) — speed is "per video" by convention,
  // not a persisted preference. Local useState (not store) so it doesn't
  // touch disk on every nudge.
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [controlsVisible, setControlsVisible] = useState(true);
  // Mirror of the Tauri window's fullscreen flag. We can't rely on
  // `document.fullscreenElement` on the native-mpv path because our
  // toggle now flips the OS-level window fullscreen (so the mpv popup
  // follows) instead of the HTML element's. The .player-stage CSS
  // normally clamps itself to max-width 72rem / 16:9 on desktop so a
  // non-maximized Tauri window shows a centred letterboxed box; when
  // fullscreen we need to drop that clamp or the "fullscreen" video
  // ends up a 1152px island surrounded by black.
  const [isTauriFullscreen, setIsTauriFullscreen] = useState(false);
  const hideTimerRef = useRef<number | null>(null);
  // When our own fullscreen toggle last fired. The window-resize listener
  // uses it to stay out of the way while the OS transition is in flight —
  // see the fullscreen-sync effect below.
  const fsToggledAtRef = useRef(0);

  // Mirrors of the audio/rate state for the native-mpv path. `load()` is a
  // useCallback with a tiny dep list (so a volume nudge never re-creates
  // the engine); it still needs the *current* values to push into mpv once
  // `play()` resolves, hence refs instead of deps. Kept in sync by the
  // effect right below.
  const volumeRef = useRef(volume);
  const mutedRef = useRef(muted);
  const speedRef = useRef(playbackSpeed);
  const brightnessRef = useRef(videoBrightness);
  // Latest position/duration read from mpv by the state poll further
  // down. Seeking and the Continue-Watching bookkeeping both need the
  // current numbers from inside callbacks that must not re-run on every
  // tick, so they read this ref instead of the `currentTime` state.
  const nativeTimeRef = useRef({ position: 0, duration: 0 });
  // One-shot guard for mpv's `eof-reached`, which stays true from the end
  // of a file until the next loadfile.
  const eofHandledRef = useRef(false);
  useEffect(() => {
    volumeRef.current = volume;
    mutedRef.current = muted;
    speedRef.current = playbackSpeed;
    brightnessRef.current = videoBrightness;
  }, [volume, muted, playbackSpeed, videoBrightness]);

  // Brightness on the native path: the CSS filter on the `<video>`
  // element below never touches mpv's own surface, so the slider has to
  // reach the `brightness` property in the gpu renderer instead.
  useEffect(() => {
    if (!nativeMpv.hasNativeMpv) return;
    nativeMpv.setBrightness(videoBrightness).catch(() => {});
  }, [videoBrightness]);

  const isVod = playback?.kind === "vod";
  const isLive = playback?.kind === "live";
  const hasQueue = isLive && liveQueue.length > 1;
  const isSeries = playback?.contentType === "series";
  const episodeNeighbors = useMemo(
    () => (isSeries ? findEpisodeNeighbors(playback, seriesList) : null),
    [isSeries, playback, seriesList]
  );
  const hasNextEpisode = !!episodeNeighbors?.next;
  const hasPrevEpisode = !!episodeNeighbors?.prev;

  // Netflix-style "next episode" prompt state. Triggered near the end of a
  // series episode and on the `ended` event. Dismissing keeps it hidden until
  // the next item starts.
  const [nextPromptVisible, setNextPromptVisible] = useState(false);
  const promptDismissedRef = useRef(false);
  const promptTriggeredRef = useRef(false);

  // Reload throttling state — survives across the watchdog's effect re-runs
  // (which happen on every attemptCount bump). Without these refs the
  // cooldown was a local variable that reset to 0 on every reload, allowing
  // back-to-back reloads every 8s and triggering an infinite loop when the
  // upstream is dead.
  const lastReloadAtRef = useRef(0);
  const reloadTimesRef = useRef<number[]>([]);
  // Engine generation counter. Bumped on every fresh load() so callbacks
  // captured by an older mpegts instance can compare against the current
  // value and silently bail when the engine they belong to has been
  // superseded — prevents orphaned workers from setting state, calling
  // setError, or triggering a reload after a new player has already
  // taken over. Borrowed from StreamVault's PlayerEngine pattern.
  const engineGenRef = useRef(0);

  const resetHideTimer = useCallback(() => {
    setControlsVisible(true);
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => {
      if (!menu) setControlsVisible(false);
    }, 3500);
  }, [menu]);

  useEffect(() => {
    resetHideTimer();
    return () => {
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    };
  }, [resetHideTimer, playback]);

  useEffect(() => {
    if (menu) setControlsVisible(true);
  }, [menu]);

  const cleanup = useCallback(() => {
    // Detach refs immediately — anything async below should not see a "live"
    // ref or it would fight with whatever takes its place.
    const hls = hlsRef.current;
    const mp = mpegtsRef.current;
    hlsRef.current = null;
    mpegtsRef.current = null;

    // SYNCHRONOUS: stop the old engine's HTTP IO immediately. Without this
    // the orphan's stream connection stays open until the deferred
    // setTimeout below runs, and IPTV providers that rate-limit by
    // concurrent connections per credential (e.g. vsplay.fun) see the
    // new player's connect attempt as "user already streaming" and reject
    // it with 403 — visible in the console as
    // `[IOController] > Loader error, code = 403, msg = Forbidden`.
    // unload() only touches IO loaders / workers, never the video
    // element, so it's safe to run before the new attach happens.
    if (mp) {
      try {
        mp.unload();
      } catch {}
    }

    // Defer engine teardown (destroy/detach) to a fresh task. mpegts.js
    // tears down a MediaSource synchronously on `destroy()` and that
    // sometimes briefly stalls the main thread. Doing it after the next
    // paint lets the Browser render first, so the user sees the list
    // immediately when closing live TV.
    setTimeout(() => {
      if (hls) {
        try {
          hls.destroy();
        } catch {}
      }
      if (mp) {
        // CRITICAL: under React Strict Mode (dev double-mount) AND on
        // every auto-retry (attemptCount bump), the cleanup of the
        // previous mount runs AFTER the next mount has already attached
        // a fresh mpegts player to the SAME <video>. mpegts.js's
        // `pause()` calls `video.pause()` and `detachMediaElement()` /
        // `destroy()` clear `video.src` — running any of those on the
        // orphaned old player breaks the live new player (channel never
        // starts, currentTime stuck at 0, or MSE yanked mid-stream).
        //
        // If a new player has taken over the slot, only call `unload()`
        // — that operates on IO loaders / workers internally and never
        // touches the video element. Let GC reclaim the orphan. If we're
        // truly unmounting (no new player took over), do the full
        // teardown.
        const newPlayerTookOver = !!mpegtsRef.current;
        if (newPlayerTookOver) {
          // Orphan player from a Strict Mode double-mount or HMR reload.
          // unload() already ran synchronously above. Just null the
          // _mediaElement so any pending worker messages can't write to
          // the shared <video> or to a closed SourceBuffer. We
          // deliberately skip destroy() — it tears down listeners on
          // the MediaSource / video and that cleanup has been racing
          // the new player's attach in dev. Let GC reclaim the orphan.
          const internal = mp as unknown as { _mediaElement?: unknown };
          internal._mediaElement = null;
        } else {
          // No new player took over — true unmount. Full teardown.
          // unload() already ran synchronously above; do the rest now.
          try {
            mp.pause();
          } catch {}
          try {
            mp.detachMediaElement();
          } catch {}
          try {
            mp.destroy();
          } catch {}
        }
      }
    }, 0);
  }, []);

  const load = useCallback(
    (url: string, kind: "live" | "vod") => {
      const video = videoRef.current;
      if (!video) return;

      // Native mpv path (Tauri desktop on Windows). The plugin handles
      // playback entirely in a popup window the OS composites above the
      // WebView — our `<video>` element stays mounted but just paints
      // black behind it. We tell mpv to play(), size the popup to match
      // the containerRef via setViewport (fired by the ResizeObserver
      // effect below), and short-circuit the hls.js / mpegts.js setup.
      // The web build keeps the WebView engine path untouched.
      if (nativeMpv.hasNativeMpv) {
        setEngineUsed("mpv");
        setError(null);
        setLoading(true);
        // Same reset the WebView path does below — otherwise the previous
        // channel's duration/position stays on the seek bar and its audio
        // / subtitle menus keep listing tracks that are gone, until the
        // native pollers catch up a second later.
        setCurrentTime(0);
        setDuration(0);
        setAudioTracks([]);
        setCurrentAudio(null);
        setSubtitleTracks([]);
        setCurrentSubtitle(-1);
        // VOD resume. The "seek the <video> element on loadedmetadata"
        // effect below can't work here (no media attached), so the saved
        // position rides along as mpv's `start` option instead. Read
        // straight from the store rather than through props/state so
        // `load` keeps its tiny dependency list.
        let startTime: number | undefined;
        if (kind === "vod") {
          const store = useAppStore.getState();
          const itemId = store.playback?.itemId;
          const saved = itemId ? store.watchProgress[itemId] : undefined;
          if (
            saved &&
            saved.position >= 5 &&
            (!saved.duration || saved.position < saved.duration * 0.95)
          ) {
            startTime = saved.position;
          }
        }
        // Fire-and-forget; errors come back via the native-mpv:error
        // event (M4). We don't await because this callback is sync.
        nativeMpv
          .play(url, startTime !== undefined ? { startTime } : kind === "live" ? {} : undefined)
          .then(() => {
            setLoading(false);
            setPlaying(true);
            // Once the plugin confirms play() returned, the child HWND
            // exists and we can pin it to the player-stage. The viewport
            // useEffect fires on mount but ensure_mpv runs AFTER on the
            // UI thread, so the first `setViewport()` from there races
            // the create and gets "mpv not initialized yet". Resending
            // from here guarantees the final rect lands.
            const area = videoAreaRef.current ?? containerRef.current;
            if (area) {
              const r = area.getBoundingClientRect();
              void nativeMpv.setViewport(r.left, r.top, r.width, r.height);
            }
            // Same race for the audio/rate properties: the effects that
            // watch `volume` / `muted` / `playbackSpeed` run on mount,
            // before libmpv exists, and get "mpv not initialized". Push
            // the current values now that it does. (mpv keeps `volume`
            // across loadfile, but `speed` has to be re-asserted because
            // we reset the UI to 1× on every new item.)
            nativeMpv.setVolume(volumeRef.current * 100).catch(() => {});
            nativeMpv.setMute(mutedRef.current).catch(() => {});
            nativeMpv.setSpeed(speedRef.current).catch(() => {});
            nativeMpv.setBrightness(brightnessRef.current).catch(() => {});
          })
          .catch((e: unknown) => {
            console.warn("[Player] nativeMpv.play failed", e);
            setError(
              "Não foi possível carregar. Verifique sua conexão ou contate seu provedor."
            );
            setLoading(false);
            // Move the popup off-screen so our React error overlay is
            // actually visible — otherwise the still-mounted mpv HWND
            // (even blank) sits above the WebView and the user never
            // sees the "Tentar novamente" button.
            nativeMpv.hideViewport().catch(() => {});
          });
        return;
      }

      // Tag this engine instance with a unique generation. Async callbacks
      // (mpegts events, hls error events, video element handlers) capture
      // it in their closures and bail if a newer load() has incremented
      // the counter past their copy — i.e. the callback belongs to an
      // engine that's already been superseded.
      const myGen = ++engineGenRef.current;

      cleanup();
      setError(null);
      setLoading(true);
      setCurrentTime(0);
      setDuration(0);
      setAudioTracks([]);
      setCurrentAudio(null);
      setSubtitleTracks([]);
      setCurrentSubtitle(-1);

      // On the web build, route every cross-origin upstream through the
      // deployment's generic /proxy/ so the browser sees a same-origin
      // CORS-friendly URL. No-op on Tauri / HTTP-localhost.
      const playUrl = proxify(url);

      // Robust autoplay helper. Tries video.play() immediately; if the
      // element is still paused after `canplay` fires (e.g. because Strict
      // Mode's double-mount aborted the first promise, or autoplay was
      // briefly blocked), retries once with a muted-fallback. The
      // event listener is one-shot.
      const ensurePlaying = () => {
        const tryNow = () => {
          if (!video.paused) return;
          const p = video.play();
          if (p && typeof (p as Promise<void>).catch === "function") {
            (p as Promise<void>).catch((err: { name?: string } | undefined) => {
              if (err?.name === "NotAllowedError") {
                // Browser blocked autoplay-with-sound. Fall back to a
                // muted autoplay so the user at least sees the video;
                // they can unmute via the controls bar.
                video.muted = true;
                setMuted(true);
                video.play().catch(() => {});
              }
            });
          }
        };
        tryNow();
        const onCanPlay = () => {
          video.removeEventListener("canplay", onCanPlay);
          tryNow();
        };
        video.addEventListener("canplay", onCanPlay);
      };

      const engine = selectEngine(url, kind);
      setEngineUsed(engine);

      if (engine === "hls" && Hls.isSupported()) {
        const hls = new Hls({ enableWorker: true, lowLatencyMode: kind === "live" });
        hlsRef.current = hls;
        hls.loadSource(playUrl);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          ensurePlaying();
          setAudioTracks(
            hls.audioTracks.map((t, i) => ({
              id: i,
              label: t.name || t.lang || `Áudio ${i + 1}`,
              lang: t.lang,
            }))
          );
          setCurrentAudio(hls.audioTrack);

          setSubtitleTracks(
            hls.subtitleTracks.map((t, i) => ({
              id: i,
              label: t.name || t.lang || `Legenda ${i + 1}`,
              lang: t.lang,
            }))
          );
          setCurrentSubtitle(hls.subtitleTrack);
          hls.subtitleDisplay = false;
        });

        hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_e, data) => setCurrentAudio(data.id));
        hls.on(Hls.Events.SUBTITLE_TRACK_SWITCH, (_e, data) => setCurrentSubtitle(data.id));
        hls.on(Hls.Events.ERROR, (_e, data) => {
          // Drop late events from an already-superseded engine (Strict Mode
          // double-mount, attemptCount bump, channel switch).
          if (myGen !== engineGenRef.current) return;
          if (!data.fatal) return;

          // Same auth classifier as the mpegts path. hls.js exposes the HTTP
          // response code on `data.response.code` for network errors.
          const code =
            (data as unknown as { response?: { code?: number } }).response?.code ?? 0;
          const isAuthError = code === 401 || code === 403 || code === 456;
          if (isAuthError) {
            console.warn(`[Player] hls auth error code=${code} — refusing to retry`);
            setError(
              code === 456
                ? "Limite de conexões simultâneas atingido. Feche outros dispositivos e tente novamente."
                : "Servidor recusou a conexão (rate-limit ou bloqueio temporário). Aguarde 1-2 minutos e tente novamente."
            );
            setLoading(false);
            return;
          }
          // Generic user-facing message. We deliberately don't surface the
          // hls.js error details (data.details / data.type) because for an
          // average IPTV viewer they're noise, and the previous text
          // ("HLS: bufferStalledError") only invited copy-pasting the URL —
          // which contains user/password — into chat support.
          console.warn(`[Player] hls fatal:`, data.details, data.type);
          setError("Não foi possível carregar. Verifique sua conexão ou contate seu provedor.");
          setLoading(false);
        });
        return;
      }

      if (engine === "mpegts" && mpegts.getFeatureList().mseLivePlayback) {
        const player = mpegts.createPlayer(
          {
            type: url.toLowerCase().includes(".flv") ? "flv" : "mpegts",
            isLive: kind === "live",
            url: playUrl,
          },
          {
            enableWorker: true,
            enableStashBuffer: true,
            stashInitialSize: 1024 * 1024,
            lazyLoad: false,
            lazyLoadMaxDuration: 3 * 60,
            lazyLoadRecoverDuration: 30,
            autoCleanupSourceBuffer: true,
            autoCleanupMaxBackwardDuration: 60,
            autoCleanupMinBackwardDuration: 30,
            liveBufferLatencyChasing: false,
            liveBufferLatencyMaxLatency: 8,
            liveBufferLatencyMinRemain: 2,
            fixAudioTimestampGap: false,
          }
        );
        mpegtsRef.current = player;
        player.attachMediaElement(video);
        player.on(
          mpegts.Events.ERROR,
          (type: string, detail: string, info?: { code?: number; msg?: string }) => {
            // Drop late events from an already-superseded engine.
            if (myGen !== engineGenRef.current) return;

            // Classify HTTP errors so we don't keep hammering an upstream
            // that's actively rejecting us. Borrowed from StreamVault's
            // PlayerErrorClassifier:
            //   401 / 403 / 456 → HTTP_AUTH → never retry, just surface
            //   5xx / timeout / DNS → existing watchdog handles it
            // 456 is the IPTV-specific "max connections reached" Xtream
            // panels return when the user has too many concurrent streams.
            const code = info?.code ?? 0;
            const isAuthError = code === 401 || code === 403 || code === 456;
            if (isAuthError) {
              console.warn(
                `[Player] mpegts auth error code=${code} — refusing to retry`
              );
              setError(
                code === 456
                  ? "Limite de conexões simultâneas atingido. Feche outros dispositivos e tente novamente."
                  : "Servidor recusou a conexão (rate-limit ou bloqueio temporário). Aguarde 1-2 minutos e tente novamente."
              );
              setLoading(false);
              return;
            }

            // Same rationale as the hls path: tech detail goes to console
            // only, user sees a generic, actionable message.
            console.warn(`[Player] mpegts fatal:`, type, detail);
            setError("Não foi possível carregar. Verifique sua conexão ou contate seu provedor.");
            setLoading(false);
          }
        );
        // Note: we intentionally don't subscribe to mpegts'
        // LOADING_COMPLETE for live recovery — some IPTV servers send the
        // stream as a series of short Content-Length-bound chunks and
        // emit LOADING_COMPLETE between every one of them. Handling it
        // proactively burned through all our reload attempts before the
        // first frame ever rendered. The watchdog below catches genuine
        // stalls just fine.
        player.load();
        ensurePlaying();
        return;
      }

      // native
      video.src = playUrl;
      ensurePlaying();
    },
    [cleanup]
  );

  useEffect(() => {
    if (!playback) return;
    load(playback.url, playback.kind);
    return () => {
      // Make sure we are not stuck in fullscreen — the page underneath would
      // otherwise show as a fullscreen black rectangle.
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
      // Native mpv path: tell the plugin to stop + move the popup off
      // screen. Without this the mpv window hangs around when the user
      // closes the player, floating above the catalog.
      if (nativeMpv.hasNativeMpv) {
        nativeMpv.stop().catch(() => {});
        nativeMpv.hideViewport().catch(() => {});
      }
      const v = videoRef.current;
      if (v) {
        try {
          v.pause();
          v.removeAttribute("src");
          v.load();
        } catch {}
      }
      cleanup();
    };
  }, [playback, load, cleanup, attemptCount]);

  // Reset the next-episode prompt every time playback changes (a new episode
  // started, or we left the series), so the user gets a fresh chance to be
  // prompted at the end of the new episode.
  useEffect(() => {
    setNextPromptVisible(false);
    promptDismissedRef.current = false;
    promptTriggeredRef.current = false;
    // Fresh playback → reset the reload throttle so a new channel gets a
    // clean slate of attempts.
    lastReloadAtRef.current = 0;
    reloadTimesRef.current = [];
    // Fresh playback → reset speed to 1×. Matches Netflix / YouTube etc.
    // (speed is per-video, not a global preference).
    setPlaybackSpeed(1);
  }, [playback?.itemId]);

  // Centralised reload — used by the stall watchdog. 15s cooldown +
  // max 3 reloads per 60s prevent runaway loops. We do NOT touch the
  // <video> element here: the load() useEffect's cleanup already
  // tears down the engine, and forcing `removeAttribute('src')`
  // creates a race with the new mpegts player's attachMediaElement
  // that can leave the video stuck at readyState=0 forever.
  const tryReload = useCallback((reason: string) => {
    const now = Date.now();
    if (now - lastReloadAtRef.current < 15_000) {
      console.log(`[Player] reload skipped (cooldown): ${reason}`);
      return;
    }
    reloadTimesRef.current = reloadTimesRef.current.filter((t) => now - t < 60_000);
    if (reloadTimesRef.current.length >= 3) {
      console.warn(`[Player] giving up: ${reason} (3 reloads in last 60s)`);
      setError("Stream indisponível. Tente novamente em alguns segundos.");
      setLoading(false);
      return;
    }
    reloadTimesRef.current.push(now);
    lastReloadAtRef.current = now;
    console.warn(`[Player] reloading: ${reason}`);
    setAttemptCount((c) => c + 1);
  }, []);

  // Stall watchdog for live streams. mpegts.js can get stuck in an
  // infinite-loading state after the upstream closes the connection — the
  // decoder runs dry, MSE buffer underruns, the engine auto-pauses, and
  // playback never recovers on its own.
  //
  // Frame-aware health check (Fix B, borrowed from StreamVault's
  // VideoStallDetector). We track BOTH `currentTime` AND
  // `getVideoPlaybackQuality().totalVideoFrames`. If either is advancing,
  // the stream is healthy. This catches two edge cases that a pure
  // currentTime watchdog misses:
  //
  //   • PTS drift / playlist edge: mpegts.js sometimes ticks currentTime
  //     because of timestamp adjustments while no actual frames render —
  //     looks "fine" but viewer sees a freeze. Frame counter does not lie.
  //   • Buffered-but-not-decoding: data arrived, MSE has it, but the
  //     decoder is wedged. currentTime stays put; frame counter also stays
  //     put — we want to reload.
  //
  // We exempt the case where the user explicitly paused with a healthy
  // buffer (`paused && bufferAhead >= 0.5 && readyState >= 3`) — that's a
  // legitimate pause, not a stall. Everything else after the timeout is
  // treated as engine death and triggers a reload.
  useEffect(() => {
    if (!playback || playback.kind !== "live") return;
    const video = videoRef.current;
    if (!video) return;

    // Browser quirks: getVideoPlaybackQuality is on HTMLVideoElement in
    // Chrome/Safari; older Firefox exposed only the deprecated
    // .mozPaintedFrames. Both Tauri (CEF/WebView2) and modern browsers
    // we ship to support the standard call, but we still feature-detect
    // so a missing method doesn't blow up the watchdog.
    const getFrames = (): number => {
      const q = (video as HTMLVideoElement & {
        getVideoPlaybackQuality?: () => { totalVideoFrames: number };
      }).getVideoPlaybackQuality?.();
      return q?.totalVideoFrames ?? 0;
    };

    let lastTime = video.currentTime;
    let lastFrames = getFrames();
    let lastChangeAt = Date.now();
    // Only enable stall detection AFTER the stream has actually started
    // playing (currentTime advanced past a small threshold at least once).
    // This is what tells "channel never connected, stop bothering" apart
    // from "channel was playing and froze, recover please". Without this,
    // a slow-to-start channel triggers the watchdog before the first
    // frame ever arrives, leading to reload storms that prevent it from
    // ever starting.
    let hasStarted = false;

    const interval = window.setInterval(() => {
      const nowFrames = getFrames();

      if (!hasStarted) {
        if (video.currentTime > 5 || nowFrames > 0) {
          hasStarted = true;
        } else {
          // still booting — leave alone
          lastTime = video.currentTime;
          lastFrames = nowFrames;
          lastChangeAt = Date.now();
          return;
        }
      }

      if (video.seeking) {
        lastTime = video.currentTime;
        lastFrames = nowFrames;
        lastChangeAt = Date.now();
        return;
      }

      // How much buffered data lies ahead of the playhead? 0 = at the edge,
      // about to starve. We look at the trailing buffered range because for
      // live streams that's the only one that matters.
      let bufferAhead = 0;
      if (video.buffered.length > 0) {
        const lastEnd = video.buffered.end(video.buffered.length - 1);
        bufferAhead = Math.max(0, lastEnd - video.currentTime);
      }

      // Healthy if EITHER currentTime advanced OR a new frame was decoded
      // since last tick. Frame progress is the stronger signal — it means
      // pixels actually changed on screen — but currentTime alone is enough
      // for engines that report frames lazily.
      const timeAdvanced = video.currentTime !== lastTime;
      const framesAdvanced = nowFrames > lastFrames;
      if (timeAdvanced || framesAdvanced) {
        lastTime = video.currentTime;
        lastFrames = nowFrames;
        lastChangeAt = Date.now();
        return;
      }

      // Nothing advanced. Is it a legitimate user pause? Only if paused
      // with a comfortable buffer and ready data.
      if (video.paused && bufferAhead >= 0.5 && video.readyState >= 3) {
        lastTime = video.currentTime;
        lastFrames = nowFrames;
        lastChangeAt = Date.now();
        return;
      }

      const stalledMs = Date.now() - lastChangeAt;
      if (stalledMs > 8_000) {
        const reason =
          `stall readyState=${video.readyState} paused=${video.paused} ` +
          `bufferAhead=${bufferAhead.toFixed(2)}s frames=${nowFrames} ` +
          `stuck ${Math.round(stalledMs / 1000)}s`;
        // Reset our local stall timer so we don't re-fire every tick if
        // tryReload short-circuits on cooldown.
        lastChangeAt = Date.now();
        tryReload(reason);
      }
    }, 2000);

    return () => window.clearInterval(interval);
    // attemptCount is in deps so the watchdog re-arms cleanly after each
    // automatic reload (and after the user manually retries too). tryReload
    // is referentially stable (useCallback with empty deps) so it doesn't
    // cause re-runs.
  }, [playback, attemptCount, tryReload]);

  // Native mpv viewport sync. The plugin draws into a popup window that
  // the OS composites above the WebView — but WebView doesn't know
  // anything about the popup's existence, so we have to tell the plugin
  // where to put it. Any time the player-stage changes position or size
  // (window resize, fullscreen toggle, dev-tools opening) we recompute
  // the client-area rect and push it. ResizeObserver covers the "stage
  // grew/shrunk" case; window resize covers the ancestor-chain case
  // (e.g. the whole app window grew but the stage percentage layout
  // stayed the same so the ResizeObserver didn't fire).
  // Keep `isTauriFullscreen` in sync with the actual window state, so
  // we also catch F11 / taskbar maximize that didn't go through our
  // toggle button.
  useEffect(() => {
    if (!nativeMpv.hasNativeMpv) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        const fs = await win.isFullscreen();
        if (!cancelled) setIsTauriFullscreen(fs);
        unlisten = await win.onResized(async () => {
          // Ignore the resize storm our own toggle causes. `setFullscreen`
          // resizes the window before Tauri's `isFullscreen()` flips, so
          // querying it here would answer with the OLD value and undo the
          // optimistic flag — the stage snapped back to its clamped
          // 72rem/16:9 box and "fullscreen" looked like a letterboxed
          // island. Outside that window (F11, taskbar maximize, the OS
          // leaving fullscreen on its own) the query is still what keeps
          // the flag honest.
          if (Date.now() - fsToggledAtRef.current < 1000) return;
          try {
            const nowFs = await win.isFullscreen();
            setIsTauriFullscreen(nowFs);
          } catch {}
        });
      } catch (e) {
        console.warn("[Player] fullscreen sync setup failed", e);
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!nativeMpv.hasNativeMpv || !playback) return;
    const area = videoAreaRef.current;
    if (!area) return;

    const push = () => {
      const r = area.getBoundingClientRect();
      void nativeMpv.setViewport(r.left, r.top, r.width, r.height);
    };
    push();

    // Observing videoAreaRef (not containerRef) means the CSS transition
    // that shrinks the area when controls appear — and expands it when
    // they auto-hide — fires a `resize` for every intermediate frame.
    // The popup follows along, so controls slide in over black strips
    // instead of over live video, and the video crops/uncrops smoothly.
    const ro = new ResizeObserver(push);
    ro.observe(area);
    window.addEventListener("resize", push);
    // Fullscreen entering/exiting fires fullscreenchange on the document
    // and we need to re-push once the layout settles — defer by a frame.
    const onFs = () => requestAnimationFrame(push);
    document.addEventListener("fullscreenchange", onFs);

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", push);
      document.removeEventListener("fullscreenchange", onFs);
    };
  }, [playback]);

  // Resume playback at saved position for VOD items with known progress.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playback || playback.kind !== "vod" || !playback.itemId) return;
    const saved = watchProgress[playback.itemId];
    if (!saved || saved.position < 5) return;

    const resume = () => {
      if (video.duration && saved.position < video.duration * 0.95) {
        video.currentTime = saved.position;
      }
    };
    if (video.readyState >= 1) resume();
    else video.addEventListener("loadedmetadata", resume, { once: true });
    return () => video.removeEventListener("loadedmetadata", resume);
    // We intentionally read watchProgress once when the item changes — we don't
    // want to re-seek every time progress updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playback?.itemId, attemptCount]);

  // Save progress every 5s while playing (VOD only).
  useEffect(() => {
    if (!playback || playback.kind !== "vod" || !playback.itemId) return;
    const video = videoRef.current;
    if (!video) return;
    const itemId = playback.itemId;

    const tick = () => {
      const v = videoRef.current;
      // On the native path the `<video>` element has no media attached —
      // position and duration come from mpv via the state poll. Without
      // this branch Continue Watching silently stopped recording anything
      // on the desktop build.
      const native = nativeMpv.hasNativeMpv;
      const position = native ? nativeTimeRef.current.position : v?.currentTime ?? 0;
      const total = native ? nativeTimeRef.current.duration : v?.duration ?? 0;
      // Paused playback can't advance the position, so saving while
      // paused is harmless — we only skip it on the WebView path to keep
      // the original behaviour untouched.
      if (!native && (!v || v.paused)) return;
      if (!isFinite(total) || total < 60) return;
      const pct = position / total;
      if (pct >= 0.95) {
        // Watched to the end — remove from continue watching
        clearProgress(itemId);
        return;
      }
      if (position < 5) return;
      saveProgress({
        itemId,
        parentId: playback.parentId,
        position,
        duration: total,
        updatedAt: Date.now(),
        title: playback.title,
        subtitle: playback.subtitle,
        logo: playback.logo,
        contentType: playback.contentType === "series" ? "series" : "movie",
      });
    };

    const interval = setInterval(tick, 5000);
    return () => {
      clearInterval(interval);
      tick(); // final save on unmount
    };
    // nativeTimeRef is a ref — stable, intentionally not a dependency.
  }, [playback, saveProgress, clearProgress]);

  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      video.volume = volume;
      video.muted = muted;
    }
    // Native path: the `<video>` element is silent and parked behind the
    // mpv popup, so the slider has to reach libmpv instead. Rejections
    // ("mpv not initialized") are expected before the first play() and
    // get re-applied from load()'s .then().
    if (nativeMpv.hasNativeMpv) {
      nativeMpv.setVolume(volume * 100).catch(() => {});
      nativeMpv.setMute(muted).catch(() => {});
    }
  }, [volume, muted]);

  // Apply current playback speed. mpegts.js / hls.js never touch
  // playbackRate themselves on live streams so this is purely a VOD
  // concern, but we apply it unconditionally — keeps the wire-up simple
  // and a live stream with rate ≠ 1 just falls back to 1 naturally when
  // the buffer can't keep up.
  useEffect(() => {
    const video = videoRef.current;
    if (video && video.playbackRate !== playbackSpeed) {
      video.playbackRate = playbackSpeed;
    }
    if (nativeMpv.hasNativeMpv) {
      nativeMpv.setSpeed(playbackSpeed).catch(() => {});
    }
  }, [playbackSpeed, playback]);

  // Leave OS-level fullscreen when the player closes.
  //
  // The native path toggles the *window* fullscreen (so the mpv popup
  // follows along) rather than `document.requestFullscreen`, so the
  // `document.fullscreenElement` cleanup in the playback effect never
  // applies here — closing a channel while fullscreen left the whole app
  // fullscreen on top of the catalog.
  //
  // It has to hang off unmount, not off `playback`: App renders
  // `{playback && <Player />}`, so when playback stops this component is
  // gone and an effect keyed on `playback` never gets to see the null.
  // And it can't live in the playback effect's cleanup either — that one
  // also runs on every channel change, where dropping fullscreen would
  // be wrong.
  useEffect(() => {
    if (!nativeMpv.hasNativeMpv) return;
    const mountedAt = Date.now();
    return () => {
      // React Strict Mode (dev only) mounts → unmounts → re-mounts within
      // a few ms. That teardown isn't the user closing the player, so
      // leave fullscreen alone.
      if (Date.now() - mountedAt < 500) return;
      void (async () => {
        try {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          const win = getCurrentWindow();
          if (await win.isFullscreen()) await win.setFullscreen(false);
        } catch (e) {
          console.warn("[Player] exit fullscreen on close failed", e);
        }
      })();
    };
  }, []);

  // ---- native-mpv: playback state poll ----
  //
  // On the native path the `<video>` element never plays anything, so none
  // of the events the WebView path relies on (timeupdate, durationchange,
  // waiting, ended) ever fire. Everything the control bar needs comes from
  // polling mpv's properties every 500 ms: position + duration for the
  // seek bar, `playing` for the play/pause icon, `buffering` for the
  // spinner, and `eof` to chain the next episode.
  //
  // 500 ms is the same cadence the `<video>` timeupdate event fires at
  // (~4/s in practice), and the Rust side is five property reads behind a
  // mutex — cheap enough to leave running for the whole session.
  useEffect(() => {
    if (!nativeMpv.hasNativeMpv || !playback) return;
    eofHandledRef.current = false;
    nativeTimeRef.current = { position: 0, duration: 0 };
    let cancelled = false;

    const tick = async () => {
      let st: nativeMpv.PlaybackState;
      try {
        st = await nativeMpv.getState();
      } catch {
        return; // mpv not up yet — next tick will find it
      }
      if (cancelled || !st) return;

      nativeTimeRef.current = { position: st.position, duration: st.duration };
      setCurrentTime(st.position);
      setDuration(Number.isFinite(st.duration) && st.duration > 0 ? st.duration : 0);
      setPlaying(st.playing);
      // Only ever *raise* loading from here. `load()` already shows the
      // spinner while the channel opens and clears it when play()
      // resolves; if we mirrored `!st.playing` the spinner would also
      // appear every time the user simply pauses.
      if (st.buffering) setLoading(true);
      else if (st.playing) setLoading(false);

      // Netflix-style next-episode prompt — the native twin of the
      // `onTimeUpdate` handler on the `<video>` element.
      if (
        isSeries &&
        hasNextEpisode &&
        !promptDismissedRef.current &&
        !promptTriggeredRef.current &&
        st.duration > 60 &&
        st.duration - st.position <= 20
      ) {
        promptTriggeredRef.current = true;
        setNextPromptVisible(true);
      }

      // `eof-reached` stays true until the next loadfile (we run with
      // keep-open=yes, so mpv parks on the last frame instead of
      // unloading), hence the one-shot guard.
      if (st.eof && !eofHandledRef.current) {
        eofHandledRef.current = true;
        if (isSeries && hasNextEpisode && !promptDismissedRef.current) {
          nextEpisodeAction();
        }
      }
    };

    void tick();
    const id = window.setInterval(tick, 500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [playback, isSeries, hasNextEpisode, nextEpisodeAction]);

  // ---- native-mpv: track list poll ----
  //
  // mpv populates `track-list` asynchronously after the file opens (and
  // live streams can add tracks mid-playback), so we poll instead of
  // reading once. The signature check keeps React from re-rendering the
  // menus on every tick.
  useEffect(() => {
    if (!nativeMpv.hasNativeMpv || !playback) return;
    let cancelled = false;
    let lastSig = "";

    const poll = async () => {
      let tracks: nativeMpv.Track[];
      try {
        tracks = await nativeMpv.getTracks();
      } catch {
        return;
      }
      if (cancelled || !tracks) return;
      const sig = tracks.map((t) => `${t.kind}:${t.id}:${t.selected ? 1 : 0}`).join("|");
      if (sig === lastSig) return;
      lastSig = sig;

      const audio = tracks.filter((t) => t.kind === "audio");
      const subs = tracks.filter((t) => t.kind === "sub");
      // `id` here is the mpv track id (what `aid` / `sid` take), not an
      // array index like on the hls.js path — selectAudio / selectSubtitle
      // branch on the engine and pass it straight through.
      setAudioTracks(
        audio.map((t, i) => ({
          id: t.id,
          label: t.title || t.lang || `Áudio ${i + 1}`,
          lang: t.lang,
        }))
      );
      setSubtitleTracks(
        subs.map((t, i) => ({
          id: t.id,
          label: t.title || t.lang || `Legenda ${i + 1}`,
          lang: t.lang,
        }))
      );
      const selAudio = audio.find((t) => t.selected);
      setCurrentAudio(selAudio ? selAudio.id : null);
      const selSub = subs.find((t) => t.selected);
      setCurrentSubtitle(selSub ? selSub.id : -1);
    };

    void poll();
    const id = window.setInterval(poll, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [playback]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onEnter = () => setIsPip(true);
    const onLeave = () => setIsPip(false);
    video.addEventListener("enterpictureinpicture", onEnter);
    video.addEventListener("leavepictureinpicture", onLeave);
    return () => {
      video.removeEventListener("enterpictureinpicture", onEnter);
      video.removeEventListener("leavepictureinpicture", onLeave);
    };
  }, [playback]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const updateTextTracks = () => {
      const tt = Array.from(video.textTracks);
      setSubtitleTracks(
        tt.map((t, i) => ({
          id: i,
          label: t.label || t.language || `Legenda ${i + 1}`,
          lang: t.language,
        }))
      );
      const active = tt.findIndex((t) => t.mode === "showing");
      setCurrentSubtitle(active);
    };

    const updateAudioTracks = () => {
      const at = (video as any).audioTracks;
      if (!at || typeof at.length !== "number") return;
      const mapped: Track[] = [];
      for (let i = 0; i < at.length; i++) {
        const a = at[i];
        mapped.push({
          id: i,
          label: a.label || a.language || `Áudio ${i + 1}`,
          lang: a.language,
        });
        if (a.enabled) setCurrentAudio(i);
      }
      setAudioTracks(mapped);
    };

    const onMeta = () => {
      if (engineUsed !== "hls") {
        updateTextTracks();
        updateAudioTracks();
      }
    };

    video.addEventListener("loadedmetadata", onMeta);
    video.textTracks.addEventListener?.("addtrack", updateTextTracks);
    video.textTracks.addEventListener?.("removetrack", updateTextTracks);
    return () => {
      video.removeEventListener("loadedmetadata", onMeta);
      video.textTracks.removeEventListener?.("addtrack", updateTextTracks);
      video.textTracks.removeEventListener?.("removetrack", updateTextTracks);
    };
  }, [engineUsed, playback]);

  if (!playback) return null;

  const togglePlay = () => {
    // Native mpv path: ignore the <video> element (it's paused black
    // behind the popup anyway) and talk to the plugin instead. We flip
    // the local `playing` state optimistically so the button icon
    // updates without waiting on an event round-trip.
    if (nativeMpv.hasNativeMpv) {
      if (playing) {
        void nativeMpv.pause();
        setPlaying(false);
      } else {
        void nativeMpv.resume();
        setPlaying(true);
      }
      return;
    }
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play();
    else v.pause();
  };

  const togglePip = async () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (document.pictureInPictureEnabled) {
        await v.requestPictureInPicture();
      }
    } catch (e) {
      console.error("PiP error", e);
    }
  };

  const toggleFullscreen = async () => {
    // Native mpv path: HTML `requestFullscreen` on the containerRef puts
    // WebView2 into its own fullscreen compositor, and our top-level mpv
    // popup either gets painted behind it or stops receiving the
    // HTTRANSPARENT hit-test (so mouse-wiggles no longer wake up the
    // controls). Flipping the Tauri window to OS-level fullscreen keeps
    // the WebView in its normal compositing tree, and the popup follows
    // along via the `on_window_event` Moved/Resized listener in the
    // plugin — same relative position, same hit-test transparency.
    if (nativeMpv.hasNativeMpv) {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        const isFs = await win.isFullscreen();
        // Mark the toggle BEFORE the call so the onResized listener skips
        // the resizes it triggers (it would otherwise read a stale
        // isFullscreen() and revert the flag below).
        fsToggledAtRef.current = Date.now();
        await win.setFullscreen(!isFs);
        fsToggledAtRef.current = Date.now();
        // Optimistic — the resize-listener effect below will reconcile
        // the flag on the next frame via `win.isFullscreen()`, but
        // flipping it here avoids a one-frame flash of the clamped
        // 72rem stage while the OS animation is still unfolding.
        setIsTauriFullscreen(!isFs);
      } catch (e) {
        console.warn("[Player] setFullscreen failed", e);
      }
      return;
    }
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else el.requestFullscreen();
  };

  const seekBy = (delta: number) => {
    if (!isVod) return;
    // Native path: position/duration live in mpv, mirrored into
    // nativeTimeRef by the state poll. Seeking the `<video>` element
    // would do nothing (it has no media attached).
    if (nativeMpv.hasNativeMpv) {
      const { position, duration: dur } = nativeTimeRef.current;
      if (!(dur > 0)) return;
      const next = Math.max(0, Math.min(dur - 1, position + delta));
      void nativeMpv.seek(next);
      nativeTimeRef.current = { position: next, duration: dur };
      setCurrentTime(next);
      return;
    }
    const v = videoRef.current;
    if (!v) return;
    const next = Math.max(0, Math.min((v.duration || 0) - 1, v.currentTime + delta));
    v.currentTime = next;
    setCurrentTime(next);
  };

  const seekTo = (ratio: number) => {
    if (!isVod) return;
    if (nativeMpv.hasNativeMpv) {
      const { duration: dur } = nativeTimeRef.current;
      if (!(dur > 0)) return;
      const t = Math.max(0, Math.min(dur, dur * ratio));
      void nativeMpv.seek(t);
      nativeTimeRef.current = { position: t, duration: dur };
      setCurrentTime(t);
      return;
    }
    const v = videoRef.current;
    if (!v || !Number.isFinite(v.duration)) return;
    const t = Math.max(0, Math.min(v.duration, v.duration * ratio));
    v.currentTime = t;
    setCurrentTime(t);
  };

  const selectAudio = (id: number) => {
    // Native path: `id` is an mpv track id, straight into `aid`. This is
    // the dual-audio case that motivated the whole libmpv pivot — hls.js
    // / mpegts.js inside WebView2 never exposed the second audio track on
    // the providers we use.
    if (nativeMpv.hasNativeMpv) {
      void nativeMpv.setAudioTrack(id);
      setCurrentAudio(id);
      setMenu(null);
      return;
    }
    if (hlsRef.current) {
      hlsRef.current.audioTrack = id;
    } else {
      const at = (videoRef.current as any)?.audioTracks;
      if (at) {
        for (let i = 0; i < at.length; i++) at[i].enabled = i === id;
      }
    }
    setCurrentAudio(id);
    setMenu(null);
  };

  const selectSubtitle = (id: number) => {
    // Native path: negative id means "off" (`sid=no`) — matches the
    // convention the menu already uses for the WebView engines.
    if (nativeMpv.hasNativeMpv) {
      void nativeMpv.setSubtitleTrack(id >= 0 ? id : null);
      setCurrentSubtitle(id);
      setMenu(null);
      return;
    }
    if (hlsRef.current) {
      hlsRef.current.subtitleTrack = id;
      hlsRef.current.subtitleDisplay = id >= 0;
    } else {
      const tt = videoRef.current?.textTracks;
      if (tt) {
        for (let i = 0; i < tt.length; i++) tt[i].mode = i === id ? "showing" : "disabled";
      }
    }
    setCurrentSubtitle(id);
    setMenu(null);
  };

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(playback.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.error(e);
    }
  };

  const retry = () => setAttemptCount((a) => a + 1);

  const onKeyDown = (e: React.KeyboardEvent) => {
    resetHideTimer();
    if (e.key === " ") {
      e.preventDefault();
      togglePlay();
    } else if (e.key === "ArrowRight" && isVod) {
      e.preventDefault();
      seekBy(10);
    } else if (e.key === "ArrowLeft" && isVod) {
      e.preventDefault();
      seekBy(-10);
    } else if ((e.key === "ArrowRight" || e.key === "PageDown") && hasQueue) {
      e.preventDefault();
      nextLive();
    } else if ((e.key === "ArrowLeft" || e.key === "PageUp") && hasQueue) {
      e.preventDefault();
      prevLive();
    } else if (e.key === "f") {
      e.preventDefault();
      toggleFullscreen();
    } else if (e.key === "Escape") {
      stop();
    } else if ((e.key === "n" || e.key === "N") && isSeries && hasNextEpisode) {
      e.preventDefault();
      nextEpisodeAction();
    } else if ((e.key === "p" || e.key === "P") && isSeries && hasPrevEpisode) {
      e.preventDefault();
      prevEpisodeAction();
    } else if (e.key === "[") {
      e.preventDefault();
      adjustBrightness(-0.05);
    } else if (e.key === "]") {
      e.preventDefault();
      adjustBrightness(0.05);
    } else if (e.key === "\\") {
      e.preventDefault();
      updateSettings({ videoBrightness: 1 });
    }
  };

  // Clamped brightness adjustment shared between the slider and the
  // keyboard shortcuts. Range matches the slider in the menu.
  const adjustBrightness = (delta: number) => {
    const next = Math.max(0.5, Math.min(2, +(videoBrightness + delta).toFixed(2)));
    if (next !== videoBrightness) updateSettings({ videoBrightness: next });
  };

  const audioDisabled = audioTracks.length <= 1;
  const subsDisabled = subtitleTracks.length === 0;
  // Any floating panel on screen? Used to carve a strip out of the mpv
  // popup on the right so the panel is actually visible (see the video
  // area's `right` inset below).
  const overlayPanelOpen = menu !== null || nextPromptVisible;

  return (
    <div
      // `player-wrapper` opts into the dynamic-viewport-height + safe-area
      // padding rules in index.css so the player adapts when Chrome's URL
      // bar slides in/out and never sits under the system gesture / status
      // bars. In OS-fullscreen (native-mpv path) we drop the wrapper padding
      // and the stage's max-width / 16:9 clamp so the video actually fills
      // the screen — otherwise the stage stays a 1152px island.
      className={`player-wrapper fixed inset-0 z-50 bg-black/95 flex items-center justify-center ${
        isTauriFullscreen ? "p-0" : "p-1 sm:p-6"
      }`}
      onKeyDown={onKeyDown}
      onMouseMove={resetHideTimer}
      // Touch support: tapping the screen reveals the controls (mobile has
      // no mousemove). Without this, autohide leaves the user unable to
      // reach the close button on a phone.
      onTouchStart={resetHideTimer}
      onClick={resetHideTimer}
      tabIndex={0}
    >
      {/* Always-visible close button on TOUCH devices (phones / tablets).
          Positioned with safe-area insets so neither the Android status
          bar nor a notch covers it. The visibility itself is gated by a
          `(hover: none) and (pointer: coarse)` media query in index.css —
          using Tailwind's `sm:hidden` doesn't work because phones in
          landscape easily exceed the sm breakpoint (640px) and the button
          would disappear right when it's most needed. */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          stop();
        }}
        className="player-close-fixed"
        aria-label={t("player.close")}
      >
        <IconClose />
      </button>

      <div
        ref={containerRef}
        className={`player-stage relative bg-black overflow-hidden shadow-2xl ${
          isTauriFullscreen ? "player-stage-fs" : ""
        } ${!controlsVisible ? "cursor-none" : ""}`}
        onMouseMove={resetHideTimer}
      >
        {/* Dedicated video area the native-mpv popup is pinned to. On
            Windows the plugin paints into a top-level HWND that the OS
            composites above WebView2 (DirectComposition won't let in-
            window Z-order lift us over WebView), so wherever this div
            sits is wherever the video sits. When controls are visible
            we inset the area by TOP_BAR_H / BOTTOM_BAR_H so the React
            overlays above are drawn in strips the HWND no longer covers.
            On the web / WebView engines the inline <video> fills this
            box and the overlays naturally sit on top via CSS Z-order —
            the inset is a no-op there. */}
        <div
          ref={videoAreaRef}
          className="absolute left-0 bg-black transition-[top,bottom,right] duration-200 ease-out"
          style={{
            top: nativeMpv.hasNativeMpv && controlsVisible ? "72px" : 0,
            bottom: nativeMpv.hasNativeMpv && controlsVisible ? "96px" : 0,
            // Floating panels (audio / subtitle / brightness / speed
            // menus, next-episode prompt) are positioned `right-4
            // bottom-24` INSIDE the stage — i.e. squarely inside the
            // rect the mpv popup covers, where the OS composites them
            // away and the user sees nothing happen on click. Pull the
            // video area in from the right while one is open so the
            // panel lands on a strip the popup no longer owns. 352px
            // clears the widest one (w-80 + right-4).
            right: nativeMpv.hasNativeMpv && overlayPanelOpen ? "352px" : 0,
          }}
        >
        <video
          ref={videoRef}
          className="w-full h-full bg-black"
          // GPU-accelerated brightness adjustment. WebView2 on Windows pushes
          // <video> through the OS color pipeline, which darkens content
          // compared with native players (VLC, mpv). Users can compensate
          // here without us having to do anything at the decoder level.
          // `willChange: filter` hints the compositor to keep the layer on
          // the GPU so the slider feels smooth in real time.
          style={
            videoBrightness !== 1
              ? { filter: `brightness(${videoBrightness})`, willChange: "filter" }
              : undefined
          }
          autoPlay
          playsInline
          onPlay={() => {
            setPlaying(true);
            setLoading(false);
          }}
          onPause={() => setPlaying(false)}
          onWaiting={() => setLoading(true)}
          onPlaying={() => setLoading(false)}
          onTimeUpdate={(e) => {
            const ct = e.currentTarget.currentTime;
            setCurrentTime(ct);
            // Show "next episode" prompt during the final 20s of the episode
            // (gives the user time to read it during end credits).
            const dur = e.currentTarget.duration;
            if (
              isSeries &&
              hasNextEpisode &&
              !promptDismissedRef.current &&
              !promptTriggeredRef.current &&
              Number.isFinite(dur) &&
              dur > 60 &&
              dur - ct <= 20
            ) {
              promptTriggeredRef.current = true;
              setNextPromptVisible(true);
            }
          }}
          onEnded={() => {
            // If the user dismissed the prompt or there's no next ep, do
            // nothing (let the saveProgress effect mark it as watched).
            if (isSeries && hasNextEpisode && !promptDismissedRef.current) {
              nextEpisodeAction();
            }
          }}
          onDurationChange={(e) => {
            const d = e.currentTarget.duration;
            setDuration(Number.isFinite(d) ? d : 0);
          }}
          onError={() => {
            const v = videoRef.current;
            const err = v?.error;
            // Tech details (MediaError code + browser message) go to console
            // only — user sees a generic, non-leaky message. Same rationale
            // as the hls / mpegts handlers above.
            if (err) console.warn(`[Player] video error code=${err.code} msg=${err.message}`);
            setError("Não foi possível carregar. Verifique sua conexão ou contate seu provedor.");
            setLoading(false);
          }}
          onClick={togglePlay}
        />
        </div>

        {loading && !error && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-12 h-12 border-4 border-white/20 border-t-white rounded-full animate-spin" />
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center bg-black/60">
            <div className="text-red-400 font-medium">{error}</div>
            {/* The previous overlay printed the upstream URL inline, which on
                Xtream / direct-stream sources contains the user's username
                and password (e.g. `http://host:port/USER/PASS/12345`). That
                made support-chat screenshots accidentally leak credentials.
                We keep only the engine + kind (no PII) for debug context. */}
            <div className="text-slate-400 text-xs">
              Engine: <span className="text-slate-200">{engineUsed}</span>
              {" · "}Tipo: <span className="text-slate-200">{playback.kind}</span>
            </div>
            <div className="flex gap-2 mt-2">
              <button onClick={retry} className="btn-primary">
                <IconRetry /> Tentar novamente
              </button>
              {IS_TAURI && (
                <button onClick={copyUrl} className="btn-ghost">
                  {copied ? <IconCheck /> : <IconCopy />}
                  {copied ? "Copiado" : "Copiar URL"}
                </button>
              )}
              <button onClick={stop} className="btn-ghost">
                <IconClose /> Fechar
              </button>
            </div>
          </div>
        )}

        <div
          className={`absolute top-0 left-0 right-0 p-4 bg-gradient-to-b from-black/95 via-black/70 to-transparent flex items-start gap-3 transition-opacity duration-300 z-10 ${
            controlsVisible ? "opacity-100" : "opacity-0 pointer-events-none"
          }`}
        >
          <div className="flex-1 min-w-0">
            <div className="text-xs text-slate-300">
              {playback.subtitle || (isVod ? t("player.watching") : t("player.live"))}
              {hasQueue && (
                <span className="ml-2 tabular-nums text-slate-400">
                  · {liveQueueIndex + 1}/{liveQueue.length}
                </span>
              )}
            </div>
            <div className="font-semibold truncate">{playback.title}</div>
            {isLive && showEpgSetting && (
              <div className="mt-1.5 text-xs leading-tight space-y-0.5 max-w-3xl">
                {epgLoading && currentEpg.length === 0 && (
                  <div className="text-slate-500">EPG…</div>
                )}
                {currentEpg.slice(0, 2).map((p, i) => (
                  <div key={i} className="flex gap-2 truncate">
                    <span
                      className={`shrink-0 tabular-nums ${
                        p.nowPlaying ? "text-accent font-medium" : "text-slate-500"
                      }`}
                    >
                      {p.nowPlaying ? "AGORA" : formatEpgTime(p.start)}
                    </span>
                    <span className={p.nowPlaying ? "text-slate-100" : "text-slate-400"}>
                      {p.title || "—"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
          {/* URL copy is desktop-only — the web build serves everything
              through the /proxy/ layer so the raw upstream URL would be
              meaningless to most users. The external-mpv handoff button
              that used to live here was removed once the native libmpv
              engine took over on Windows. */}
          {IS_TAURI && (
            <button
              onClick={copyUrl}
              className="btn-ghost"
              title={t("player.copyUrl")}
              aria-label={t("player.copyUrl")}
            >
              {copied ? <IconCheck /> : <IconCopy />}
            </button>
          )}
          <button onClick={stop} className="btn-ghost" aria-label={t("player.close")}>
            <IconClose />
          </button>
        </div>
        {(menu === "audio" || menu === "sub") && (
          <TrackMenu
            title={menu === "audio" ? t("player.audioMenu") : t("player.subMenu")}
            tracks={menu === "audio" ? audioTracks : subtitleTracks}
            current={menu === "audio" ? currentAudio : currentSubtitle}
            allowOff={menu === "sub"}
            onSelect={(id) => (menu === "audio" ? selectAudio(id) : selectSubtitle(id))}
            onClose={() => setMenu(null)}
            offLabel={t("player.off")}
            emptyHint={
              menu === "audio"
                ? isVod
                  ? t("player.emptyAudioVod")
                  : t("player.emptyAudioLive")
                : isVod
                ? t("player.emptySubVod")
                : t("player.emptySubLive")
            }
          />
        )}

        {menu === "brightness" && (
          <BrightnessMenu
            value={videoBrightness}
            onChange={(v) => updateSettings({ videoBrightness: v })}
            onReset={() => updateSettings({ videoBrightness: 1 })}
            onClose={() => setMenu(null)}
          />
        )}

        {menu === "speed" && (
          <SpeedMenu
            value={playbackSpeed}
            onSelect={(v) => {
              setPlaybackSpeed(v);
              setMenu(null);
            }}
            onClose={() => setMenu(null)}
          />
        )}

        {nextPromptVisible && episodeNeighbors?.next && episodeNeighbors.series && (
          <NextEpisodePrompt
            next={episodeNeighbors.next}
            seriesName={episodeNeighbors.series.name}
            onPlay={() => {
              setNextPromptVisible(false);
              nextEpisodeAction();
            }}
            onCancel={() => {
              setNextPromptVisible(false);
              promptDismissedRef.current = true;
            }}
            t={t}
          />
        )}

        <div
          className={`player-controls-bar absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 via-black/40 to-transparent px-4 pt-10 pb-3 transition-opacity duration-300 ${
            controlsVisible ? "opacity-100" : "opacity-0 pointer-events-none"
          }`}
        >
          {isVod && (
            <SeekBar
              currentTime={currentTime}
              duration={duration}
              onSeek={seekTo}
            />
          )}

          <div className="flex items-center gap-2 mt-2">
            {hasQueue && (
              <button
                onClick={prevLive}
                className="btn-ghost"
                title="Canal anterior"
                aria-label="Canal anterior"
              >
                <IconSkipBack />
              </button>
            )}

            {isSeries && (
              <button
                onClick={() => prevEpisodeAction()}
                disabled={!hasPrevEpisode}
                className={`btn-ghost ${!hasPrevEpisode ? "opacity-40" : ""}`}
                title={t("player.prevEpisode")}
                aria-label={t("player.prevEpisode")}
              >
                <IconSkipBack />
              </button>
            )}

            <button onClick={togglePlay} className="btn-ghost" aria-label={playing ? "Pausar" : "Tocar"}>
              {playing ? <IconPause /> : <IconPlay />}
            </button>

            {hasQueue && (
              <button
                onClick={nextLive}
                className="btn-ghost"
                title="Próximo canal"
                aria-label="Próximo canal"
              >
                <IconSkipForward />
              </button>
            )}

            {isSeries && (
              <button
                onClick={() => nextEpisodeAction()}
                disabled={!hasNextEpisode}
                className={`btn-ghost ${!hasNextEpisode ? "opacity-40" : ""}`}
                title={t("player.nextEpisode")}
                aria-label={t("player.nextEpisode")}
              >
                <IconSkipForward />
              </button>
            )}

            {isVod && (
              <>
                <button
                  onClick={() => seekBy(-10)}
                  className="btn-ghost"
                  title="Voltar 10s (←)"
                  aria-label="Voltar 10 segundos"
                >
                  -10s
                </button>
                <button
                  onClick={() => seekBy(10)}
                  className="btn-ghost"
                  title="Avançar 10s (→)"
                  aria-label="Avançar 10 segundos"
                >
                  +10s
                </button>
              </>
            )}

            <button onClick={() => setMuted((m) => !m)} className="btn-ghost" aria-label="Mudo">
              {muted ? <IconVolumeMute /> : <IconVolume />}
            </button>

            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={muted ? 0 : volume}
              onChange={(e) => {
                setVolume(parseFloat(e.target.value));
                setMuted(false);
              }}
              className="w-20 accent-indigo-500"
              aria-label="Volume"
            />

            {isVod && (
              <span className="text-xs text-slate-300 tabular-nums ml-2">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>
            )}

            <div className="flex-1" />

            <button
              onClick={() => setMenu(menu === "audio" ? null : "audio")}
              className={`btn-ghost ${menu === "audio" ? "!text-accent" : ""} ${
                audioDisabled ? "opacity-50" : ""
              }`}
              aria-label="Áudio"
              title={
                audioTracks.length > 1
                  ? `${audioTracks.length} faixas de áudio`
                  : "Nenhuma faixa alternativa"
              }
            >
              <IconLanguage />
              {audioTracks.length > 1 && (
                <span className="text-[10px] px-1 rounded bg-white/10">{audioTracks.length}</span>
              )}
            </button>

            <button
              onClick={() => setMenu(menu === "sub" ? null : "sub")}
              className={`btn-ghost ${menu === "sub" ? "!text-accent" : ""} ${
                currentSubtitle >= 0 ? "!text-accent" : ""
              } ${subsDisabled ? "opacity-50" : ""}`}
              aria-label="Legendas"
              title={subtitleTracks.length > 0 ? `${subtitleTracks.length} legendas` : "Sem legendas"}
            >
              <IconCaptions />
              {subtitleTracks.length > 0 && (
                <span className="text-[10px] px-1 rounded bg-white/10">
                  {subtitleTracks.length}
                </span>
              )}
            </button>

            {isVod && (
              <button
                onClick={() => setMenu(menu === "speed" ? null : "speed")}
                className={`btn-ghost ${menu === "speed" ? "!text-accent" : ""} ${
                  playbackSpeed !== 1 ? "!text-accent" : ""
                }`}
                aria-label="Velocidade"
                title={playbackSpeed === 1 ? "Velocidade" : `Velocidade: ${playbackSpeed}×`}
              >
                <IconSpeed />
                {playbackSpeed !== 1 && (
                  <span className="text-[10px] px-1 rounded bg-white/10 tabular-nums">
                    {playbackSpeed}×
                  </span>
                )}
              </button>
            )}

            <button
              onClick={() => setMenu(menu === "brightness" ? null : "brightness")}
              className={`btn-ghost ${menu === "brightness" ? "!text-accent" : ""} ${
                videoBrightness !== 1 ? "!text-accent" : ""
              }`}
              aria-label="Brilho"
              title={
                videoBrightness === 1
                  ? "Brilho ( [  ]  )"
                  : `Brilho: ${Math.round(videoBrightness * 100)}%`
              }
            >
              <IconBrightness />
            </button>

            {/* Picture-in-Picture is a `<video>` element feature. On the
                native path the element has no media attached (mpv paints
                into its own HWND), so the button would open an empty PiP
                window — hide it instead of shipping a dead control. */}
            {!nativeMpv.hasNativeMpv && (
              <button
                onClick={togglePip}
                className={`btn-ghost ${isPip ? "!text-accent" : ""}`}
                aria-label="Picture-in-Picture"
                title="Picture-in-Picture"
              >
                <IconPip />
              </button>
            )}

            <button onClick={toggleFullscreen} className="btn-ghost" aria-label="Tela cheia" title="Tela cheia (F)">
              <IconFullscreen />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SeekBar({
  currentTime,
  duration,
  onSeek,
}: {
  currentTime: number;
  duration: number;
  onSeek: (ratio: number) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const pct = duration > 0 ? (currentTime / duration) * 100 : 0;

  const handle = (e: React.MouseEvent<HTMLDivElement>, commit = false) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    if (commit) onSeek(ratio);
    else setHover(ratio);
  };

  return (
    <div
      className="group/bar relative h-2 cursor-pointer"
      onMouseMove={(e) => handle(e)}
      onMouseLeave={() => setHover(null)}
      onClick={(e) => handle(e, true)}
    >
      <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1 bg-white/20 rounded-full" />
      {hover !== null && (
        <div
          className="absolute top-1/2 -translate-y-1/2 h-1 bg-white/30 rounded-full"
          style={{ width: `${hover * 100}%` }}
        />
      )}
      <div
        className="absolute top-1/2 -translate-y-1/2 h-1 bg-accent rounded-full"
        style={{ width: `${pct}%` }}
      />
      <div
        className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full opacity-0 group-hover/bar:opacity-100 transition-opacity -ml-1.5"
        style={{ left: `${pct}%` }}
      />
    </div>
  );
}

function TrackMenu({
  title,
  tracks,
  current,
  allowOff,
  onSelect,
  onClose,
  emptyHint,
  offLabel,
}: {
  title: string;
  tracks: Track[];
  current: number | null;
  allowOff: boolean;
  onSelect: (id: number) => void;
  onClose: () => void;
  emptyHint: string;
  offLabel: string;
}) {
  return (
    <div
      className="absolute right-4 bottom-24 z-20 w-64 bg-black/95 backdrop-blur border border-white/10 rounded-xl shadow-2xl overflow-hidden"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="px-3 py-2 border-b border-white/10 flex items-center justify-between">
        <div className="font-semibold text-sm">{title}</div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100">
          <IconClose />
        </button>
      </div>
      <div className="max-h-64 overflow-y-auto py-1">
        {allowOff && (
          <MenuRow label={offLabel} active={current === -1} onClick={() => onSelect(-1)} />
        )}
        {tracks.length === 0 && !allowOff && (
          <div className="px-3 py-3 text-xs text-slate-500">{emptyHint}</div>
        )}
        {tracks.length === 0 && allowOff && (
          <div className="px-3 py-2 text-xs text-slate-500">{emptyHint}</div>
        )}
        {tracks.map((t) => (
          <MenuRow
            key={t.id}
            label={t.label}
            sub={t.lang}
            active={current === t.id}
            onClick={() => onSelect(t.id)}
          />
        ))}
      </div>
    </div>
  );
}

function MenuRow({
  label,
  sub,
  active,
  onClick,
}: {
  label: string;
  sub?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-white/5 ${
        active ? "text-accent" : "text-slate-200"
      }`}
    >
      <span className="w-4">{active ? <IconCheck /> : null}</span>
      <span className="flex-1 truncate">{label}</span>
      {sub && sub !== label && (
        <span className="text-xs text-slate-500 uppercase">{sub}</span>
      )}
    </button>
  );
}

function BrightnessMenu({
  value,
  onChange,
  onReset,
  onClose,
}: {
  value: number;
  onChange: (v: number) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  // 50%–200% range. WebView2's darkening is ~10-15% so most users will
  // sit around 110%–125%, but we leave headroom for OLED panels and HDR
  // content that needs a much stronger lift.
  const pct = Math.round(value * 100);
  const presets = [0.9, 1, 1.1, 1.25, 1.5];
  return (
    <div
      className="absolute right-4 bottom-24 z-20 w-72 bg-black/95 backdrop-blur border border-white/10 rounded-xl shadow-2xl overflow-hidden"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="px-3 py-2 border-b border-white/10 flex items-center justify-between">
        <div className="font-semibold text-sm">Brilho</div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100">
          <IconClose />
        </button>
      </div>

      <div className="px-3 py-3">
        <div className="flex items-center justify-between text-xs text-slate-400 mb-2">
          <span>50%</span>
          <span className="text-slate-100 tabular-nums font-medium">{pct}%</span>
          <span>200%</span>
        </div>
        <input
          type="range"
          min={0.5}
          max={2}
          step={0.05}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="w-full accent-indigo-500"
          aria-label="Brilho do vídeo"
        />

        <div className="mt-3 flex gap-1.5 flex-wrap">
          {presets.map((p) => (
            <button
              key={p}
              onClick={() => onChange(p)}
              className={`text-xs px-2 py-1 rounded border transition-colors ${
                Math.abs(value - p) < 0.01
                  ? "bg-accent/20 border-accent text-accent"
                  : "border-white/10 text-slate-300 hover:bg-white/5"
              }`}
            >
              {Math.round(p * 100)}%
            </button>
          ))}
          <button
            onClick={onReset}
            className="text-xs px-2 py-1 rounded border border-white/10 text-slate-300 hover:bg-white/5 ml-auto"
            title="Reset (\\)"
          >
            Reset
          </button>
        </div>

        <div className="mt-3 text-[11px] text-slate-500 leading-snug">
          Atalhos: <span className="text-slate-300">[</span> diminui ·{" "}
          <span className="text-slate-300">]</span> aumenta ·{" "}
          <span className="text-slate-300">\</span> reset
        </div>
      </div>
    </div>
  );
}

const SPEED_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

function SpeedMenu({
  value,
  onSelect,
  onClose,
}: {
  value: number;
  onSelect: (v: number) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="absolute right-4 bottom-24 z-20 w-56 bg-black/95 backdrop-blur border border-white/10 rounded-xl shadow-2xl overflow-hidden"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="px-3 py-2 border-b border-white/10 flex items-center justify-between">
        <div className="font-semibold text-sm">Velocidade</div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-100">
          <IconClose />
        </button>
      </div>
      <div className="max-h-72 overflow-y-auto py-1">
        {SPEED_PRESETS.map((p) => {
          const active = Math.abs(value - p) < 0.001;
          return (
            <button
              key={p}
              onClick={() => onSelect(p)}
              className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-white/5 ${
                active ? "text-accent" : "text-slate-200"
              }`}
            >
              <span className="w-4">{active ? <IconCheck /> : null}</span>
              <span className="flex-1 tabular-nums">{p}×</span>
              {p === 1 && (
                <span className="text-xs text-slate-500 uppercase">Normal</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const NEXT_PROMPT_SECONDS = 10;

function NextEpisodePrompt({
  next,
  seriesName,
  onPlay,
  onCancel,
  t,
}: {
  next: Episode;
  seriesName: string;
  onPlay: () => void;
  onCancel: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const [remaining, setRemaining] = useState(NEXT_PROMPT_SECONDS);
  // Stash the latest onPlay so the interval below reads the live one rather
  // than the closure captured on first render.
  const playRef = useRef(onPlay);
  playRef.current = onPlay;

  useEffect(() => {
    const id = window.setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          window.clearInterval(id);
          // Defer the auto-play out of the setState callback to avoid React
          // warning about updating another component during render.
          window.setTimeout(() => playRef.current(), 0);
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  const label = `T${next.season}E${String(next.episode).padStart(2, "0")}`;
  const epTitle = next.title || next.name || "";
  const pct = (remaining / NEXT_PROMPT_SECONDS) * 100;

  return (
    <div
      className="absolute right-4 bottom-28 z-20 w-80 bg-black/95 backdrop-blur border border-white/10 rounded-xl shadow-2xl p-3"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="text-[11px] uppercase tracking-wider text-slate-400">
        {t("player.upNext")}
      </div>
      <div className="mt-1 font-semibold truncate">{seriesName}</div>
      <div className="text-sm text-slate-300 truncate">
        {label}
        {epTitle ? ` — ${epTitle}` : ""}
      </div>
      {next.image && (
        <img
          src={next.image}
          alt=""
          className="mt-2 w-full aspect-video object-cover rounded-md"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      )}
      <div className="mt-3 h-1 bg-white/10 rounded-full overflow-hidden">
        <div
          className="h-full bg-accent transition-[width] duration-1000 ease-linear"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-1 text-xs text-slate-400 tabular-nums">
        {t("player.startsIn", { n: remaining })}
      </div>
      <div className="mt-3 flex gap-2">
        <button onClick={onPlay} className="btn-primary flex-1 !py-1.5 !text-sm">
          <IconPlay />
          {t("player.playNow")}
        </button>
        <button onClick={onCancel} className="btn-ghost flex-1 !py-1.5 !text-sm">
          {t("player.cancelAuto")}
        </button>
      </div>
    </div>
  );
}
