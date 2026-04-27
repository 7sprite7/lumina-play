import { useEffect, useState } from "react";
import { useAppStore } from "../store";
import { IconChevronRight, IconPlay, IconStar } from "./icons";

function formatMinutes(secs: number): string {
  if (!Number.isFinite(secs) || secs <= 0) return "";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  if (m === 0) return `${s}s`;
  return `${m}min`;
}

export default function SeriesDetail() {
  const series = useAppStore((s) => s.selectedSeries);
  const loading = useAppStore((s) => s.loading);
  const error = useAppStore((s) => s.error);
  const playEpisode = useAppStore((s) => s.playEpisode);
  const watchProgress = useAppStore((s) => s.watchProgress);

  const [seasonIdx, setSeasonIdx] = useState(0);

  useEffect(() => {
    setSeasonIdx(0);
  }, [series?.id]);

  if (!series) return null;

  const seasons = series.seasons ?? [];
  const activeSeason = seasons[seasonIdx];

  return (
    <div className="flex-1 overflow-y-auto relative">
      <div className="relative h-72 md:h-80">
        {series.backdrop ? (
          <img
            src={series.backdrop}
            alt=""
            className="absolute inset-0 w-full h-full object-cover"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-fuchsia-700/30 to-purple-900/30" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-bg-900 via-bg-900/60 to-transparent" />

        <div className="absolute inset-0 flex items-end p-6 md:p-8 gap-6">
          {series.logo && (
            <img
              src={series.logo}
              alt=""
              className="hidden sm:block w-32 md:w-40 aspect-[2/3] rounded-lg object-cover shadow-2xl"
              referrerPolicy="no-referrer"
            />
          )}
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl md:text-4xl font-bold drop-shadow">{series.name}</h1>
            <div className="flex items-center gap-3 mt-2 text-sm text-slate-300">
              {series.year && <span>{series.year}</span>}
              {series.rating !== undefined && series.rating > 0 && (
                <span className="flex items-center gap-1">
                  <IconStar className="w-3.5 h-3.5 text-amber-400" />
                  {series.rating.toFixed(1)}
                </span>
              )}
              {seasons.length > 0 && (
                <span>
                  {seasons.length} {seasons.length === 1 ? "temporada" : "temporadas"}
                </span>
              )}
              <span className="text-slate-500">·</span>
              <span>{series.category}</span>
            </div>
            {series.plot && (
              <p className="mt-3 text-sm text-slate-300 max-w-3xl line-clamp-3">{series.plot}</p>
            )}
            {series.cast && (
              <p className="mt-2 text-xs text-slate-400 line-clamp-1">Elenco: {series.cast}</p>
            )}
          </div>
        </div>
      </div>

      <div className="px-6 md:px-8 pb-8">
        {loading ? (
          <div className="py-12 text-center text-slate-400">Carregando episódios...</div>
        ) : error ? (
          <div className="py-12 text-center text-red-400">{error}</div>
        ) : seasons.length === 0 ? (
          <div className="py-12 text-center text-slate-500">
            Nenhum episódio disponível para esta série.
          </div>
        ) : (
          <>
            <div className="flex gap-2 overflow-x-auto pb-1 mb-4">
              {seasons.map((s, i) => (
                <button
                  key={s.number}
                  onClick={() => setSeasonIdx(i)}
                  className={`px-4 py-1.5 rounded-full text-sm whitespace-nowrap transition-colors ${
                    i === seasonIdx
                      ? "bg-accent text-white"
                      : "bg-white/5 hover:bg-white/10 text-slate-300"
                  }`}
                >
                  Temporada {s.number || i + 1}
                  <span className="ml-2 text-xs opacity-70">{s.episodes.length}</span>
                </button>
              ))}
            </div>

            {activeSeason && (
              <ul className="space-y-2">
                {activeSeason.episodes.map((ep) => {
                  const progress = watchProgress[ep.id];
                  const pct =
                    progress && progress.duration > 0
                      ? Math.min(100, Math.max(0, (progress.position / progress.duration) * 100))
                      : 0;
                  const hasProgress = pct > 0;
                  return (
                    <li key={ep.id}>
                      <button
                        onClick={() => playEpisode(ep, series)}
                        className="group w-full flex items-center gap-4 p-3 rounded-lg bg-bg-800/80 hover:bg-bg-700 border border-white/5 hover:border-accent transition-colors text-left"
                      >
                        <div className="shrink-0 w-24 aspect-video rounded bg-bg-900 overflow-hidden flex items-center justify-center relative">
                          {ep.image ? (
                            <img
                              src={ep.image}
                              alt=""
                              className="w-full h-full object-cover"
                              referrerPolicy="no-referrer"
                            />
                          ) : (
                            <span className="text-xs text-slate-500 tabular-nums">
                              T{ep.season}E{String(ep.episode).padStart(2, "0")}
                            </span>
                          )}
                          {hasProgress && (
                            // Progress overlay on the thumbnail itself — quick
                            // visual without taking row height.
                            <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/60">
                              <div
                                className="h-full bg-accent"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs text-slate-400 tabular-nums mb-0.5 flex items-center gap-2">
                            <span>
                              T{ep.season} · Episódio {ep.episode}
                            </span>
                            {hasProgress && progress && (
                              <span className="text-accent">
                                {formatMinutes(progress.position)} / {formatMinutes(progress.duration)}
                              </span>
                            )}
                          </div>
                          <div className="text-sm font-medium truncate">{ep.title ?? ep.name}</div>
                          {ep.plot && (
                            <div className="text-xs text-slate-400 mt-1 line-clamp-2">{ep.plot}</div>
                          )}
                          {hasProgress && (
                            // Full-width progress bar below the description for
                            // a clearer "how much was watched" indicator.
                            <div className="mt-2 h-1 bg-white/10 rounded-full overflow-hidden">
                              <div
                                className="h-full bg-accent rounded-full"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          )}
                        </div>
                        <div className="shrink-0 w-10 h-10 rounded-full bg-accent/10 group-hover:bg-accent flex items-center justify-center text-accent group-hover:text-white transition-colors">
                          <IconPlay />
                        </div>
                        <IconChevronRight className="text-slate-500 group-hover:text-slate-300 shrink-0" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}
