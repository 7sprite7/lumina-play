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

    // Defer engine teardown to a fresh task. mpegts.js terminates a Web Worker
    // and tears down a MediaSource synchronously on `destroy()`; on some panels
    // that briefly stalls the main thread, which presents as a black screen
    // when closing live TV. Doing it after the next paint lets the Browser
    // render first, so the user sees the list immediately.
    setTimeout(() => {
      if (hls) {
        try {
          hls.destroy();
        } catch {}
      }
      if (mp) {
        try {
          mp.pause();
        } catch {}
        try {
          mp.unload();
        } catch {}
        try {
          mp.detachMediaElement();
        } catch {}
        try {
          mp.destroy();
        } catch {}
      }
    }, 0);
  }, []);

  const load = useCallback(
    (url: string, kind: "live" | "vod") => {
      const video = videoRef.current;
      if (!video) return;

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

      const engine = selectEngine(url, kind);
      setEngineUsed(engine);

      if (engine === "hls" && Hls.isSupported()) {
        const hls = new Hls({ enableWorker: true, lowLatencyMode: kind === "live" });
        hlsRef.current = hls;
        hls.loadSource(playUrl);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          video.play().catch(() => {});
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
          if (data.fatal) {
            setError(`HLS: ${data.details || data.type}`);
            setLoading(false);
          }
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
        player.on(mpegts.Events.ERROR, (type, detail) => {
          setError(`MPEG-TS: ${type} / ${detail}`);
          setLoading(false);
        });
        player.load();
        const p = player.play();
        if (p && typeof (p as Promise<void>).catch === "function") {
          (p as Promise<void>).catch(() => {});
        }
        return;
      }

      // native
      video.src = playUrl;
      video.play().catch(() => {});
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
  }, [playback?.itemId]);

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
