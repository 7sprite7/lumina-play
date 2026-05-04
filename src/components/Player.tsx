import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Hls from "hls.js";
import mpegts from "mpegts.js";
import type { Episode } from "../types";
import { useAppStore, findEpisodeNeighbors } from "../store";
import { selectEngine, type Engine } from "../lib/playback-engine";
import { isMpvInstalled, openInMpv } from "../lib/mpv";
import { IS_TAURI } from "../lib/platform";
import { proxify } from "../lib/proxy";
import { useT } from "../lib/i18n";
import {
  IconCaptions,
  IconCheck,
  IconClose,
  IconCopy,
  IconExternal,
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
  // Subscribe to the raw `series` array (stable reference until the catalog
  // changes) and derive neighbours via useMemo. Returning a fresh object from
  // a Zustand selector on every store tick would defeat ref-equality and
  // cause useSyncExternalStore to flag "getSnapshot should be cached" plus
  // re-render loops — observed as a black screen.
  const seriesList = useAppStore((s) => s.series);
  const t = useT();

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
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

  const [menu, setMenu] = useState<"audio" | "sub" | null>(null);
  const [mpvAvailable, setMpvAvailable] = useState<boolean | null>(null);
  const [mpvError, setMpvError] = useState<string | null>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const hideTimerRef = useRef<number | null>(null);

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

  useEffect(() => {
    isMpvInstalled().then(setMpvAvailable);
  }, []);

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
          setError(`HLS: ${data.details || data.type}`);
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

            setError(`MPEG-TS: ${type} / ${detail}`);
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
      if (!v || v.paused || !isFinite(v.duration) || v.duration < 60) return;
      const pct = v.currentTime / v.duration;
      if (pct >= 0.95) {
        // Watched to the end — remove from continue watching
        clearProgress(itemId);
        return;
      }
      if (v.currentTime < 5) return;
      saveProgress({
        itemId,
        parentId: playback.parentId,
        position: v.currentTime,
        duration: v.duration,
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
  }, [playback, saveProgress, clearProgress]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = volume;
    video.muted = muted;
  }, [volume, muted]);

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

  const toggleFullscreen = () => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else el.requestFullscreen();
  };

  const seekBy = (delta: number) => {
    const v = videoRef.current;
    if (!v || !isVod) return;
    const next = Math.max(0, Math.min((v.duration || 0) - 1, v.currentTime + delta));
    v.currentTime = next;
    setCurrentTime(next);
  };

  const seekTo = (ratio: number) => {
    const v = videoRef.current;
    if (!v || !isVod || !Number.isFinite(v.duration)) return;
    const t = Math.max(0, Math.min(v.duration, v.duration * ratio));
    v.currentTime = t;
    setCurrentTime(t);
  };

  const selectAudio = (id: number) => {
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

  const handleOpenMpv = async () => {
    if (!playback) return;
    setMpvError(null);
    try {
      // pause in-app player before handing off
      videoRef.current?.pause();
      await openInMpv(playback.url, playback.title);
    } catch (e) {
      setMpvError(e instanceof Error ? e.message : String(e));
    }
  };

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
    }
  };

  const audioDisabled = audioTracks.length <= 1;
  const subsDisabled = subtitleTracks.length === 0;

  return (
    <div
      // `player-wrapper` opts into the dynamic-viewport-height + safe-area
      // padding rules in index.css so the player adapts when Chrome's URL
      // bar slides in/out and never sits under the system gesture / status
      // bars.
      className="player-wrapper fixed inset-0 z-50 bg-black/95 flex items-center justify-center p-1 sm:p-6"
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
          !controlsVisible ? "cursor-none" : ""
        }`}
        onMouseMove={resetHideTimer}
      >
        <video
          ref={videoRef}
          className="w-full h-full bg-black"
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
            const msg = err
              ? `code ${err.code}: ${err.message || "Falha ao carregar"}`
              : "Falha ao carregar";
            setError(`Vídeo: ${msg}`);
            setLoading(false);
          }}
          onClick={togglePlay}
        />

        {loading && !error && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-12 h-12 border-4 border-white/20 border-t-white rounded-full animate-spin" />
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center bg-black/60">
            <div className="text-red-400 font-medium">{error}</div>
            <div className="text-slate-400 text-xs max-w-xl break-all">
              Engine: <span className="text-slate-200">{engineUsed}</span>
              {" · "}Tipo: <span className="text-slate-200">{playback.kind}</span>
              <br />
              URL: <span className="text-slate-200">{playback.url}</span>
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
          {/* mpv handoff and URL copy are desktop-only — the web build has no
              local mpv install and the URL would be useless to most users. */}
          {IS_TAURI && (
            <>
              <button
                onClick={handleOpenMpv}
                disabled={mpvAvailable === false}
                className="btn-ghost"
                title={mpvAvailable === false ? t("player.mpvNotFound") : t("player.openMpvHint")}
                aria-label={t("player.openMpv")}
              >
                <IconExternal />
                <span className="hidden md:inline">mpv</span>
              </button>
              <button
                onClick={copyUrl}
                className="btn-ghost"
                title={t("player.copyUrl")}
                aria-label={t("player.copyUrl")}
              >
                {copied ? <IconCheck /> : <IconCopy />}
              </button>
            </>
          )}
          <button onClick={stop} className="btn-ghost" aria-label={t("player.close")}>
            <IconClose />
          </button>
        </div>
        {mpvError && (
          <div className="absolute top-20 right-4 z-20 bg-red-500/20 border border-red-400/30 rounded-lg px-3 py-2 text-xs text-red-200 max-w-xs">
            {mpvError}
          </div>
        )}

        {menu && (
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

            <button
              onClick={togglePip}
              className={`btn-ghost ${isPip ? "!text-accent" : ""}`}
              aria-label="Picture-in-Picture"
              title="Picture-in-Picture"
            >
              <IconPip />
            </button>

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
