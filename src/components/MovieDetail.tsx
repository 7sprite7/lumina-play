import { useAppStore } from "../store";
import { useT } from "../lib/i18n";
import { IconHeart, IconPlay, IconRetry, IconStar } from "./icons";

function formatTime(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return "0:00";
  const total = Math.floor(secs);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function MovieDetail() {
  const movie = useAppStore((s) => s.selectedMovie);
  const playMovie = useAppStore((s) => s.playMovie);
  const watchProgress = useAppStore((s) => s.watchProgress);
  const clearProgress = useAppStore((s) => s.clearProgress);
  const favorites = useAppStore((s) => s.favorites);
  const toggleFavorite = useAppStore((s) => s.toggleFavorite);
  const t = useT();

  if (!movie) return null;

  const progress = watchProgress[movie.id];
  const hasProgress =
    progress &&
    progress.duration > 0 &&
    progress.position > 5 &&
    progress.position < progress.duration * 0.95;
  const pct = hasProgress ? (progress.position / progress.duration) * 100 : 0;
  const isFav = favorites.includes(movie.id);

  const year = movie.year || movie.releaseDate?.slice(0, 4);
  const genres = movie.genre?.split(/[,/|]/).map((g) => g.trim()).filter(Boolean) ?? [];
  const cast = movie.cast?.split(/[,/|]/).map((c) => c.trim()).filter(Boolean) ?? [];

  const handlePlay = () => playMovie(movie);

  const handleRestart = async () => {
    await clearProgress(movie.id);
    playMovie(movie);
  };

  return (
    <div className="flex-1 overflow-y-auto relative">
      <div className="relative h-72 md:h-[28rem]">
        {movie.backdrop ? (
          <img
            src={movie.backdrop}
            alt=""
            className="absolute inset-0 w-full h-full object-cover"
            referrerPolicy="no-referrer"
          />
        ) : movie.logo ? (
          <img
            src={movie.logo}
            alt=""
            className="absolute inset-0 w-full h-full object-cover blur-2xl scale-110 opacity-40"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-rose-700/30 to-red-900/30" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-bg-900 via-bg-900/70 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-r from-bg-900/80 via-transparent to-transparent" />

        <div className="absolute inset-0 flex items-end p-6 md:p-8 gap-6">
          {movie.logo && (
            <img
              src={movie.logo}
              alt=""
              className="hidden sm:block w-32 md:w-44 aspect-[2/3] rounded-lg object-cover shadow-2xl shrink-0"
              referrerPolicy="no-referrer"
            />
          )}
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl md:text-4xl font-bold drop-shadow">{movie.name}</h1>

            <div className="flex items-center gap-3 mt-2 text-sm text-slate-300 flex-wrap">
              {year && <span>{year}</span>}
              {movie.rating !== undefined && movie.rating > 0 && (
                <span className="flex items-center gap-1">
                  <IconStar className="w-3.5 h-3.5 text-amber-400" />
                  {movie.rating.toFixed(1)}
                </span>
              )}
              {movie.duration && <span>{movie.duration}</span>}
              <span className="text-slate-500">·</span>
              <span>{movie.category}</span>
            </div>

            {genres.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {genres.map((g) => (
                  <span
                    key={g}
                    className="text-[11px] px-2 py-0.5 rounded-full bg-white/5 text-slate-300"
                  >
                    {g}
                  </span>
                ))}
              </div>
            )}

            {movie.plot && (
              <p className="mt-3 text-sm text-slate-300 max-w-3xl line-clamp-4">{movie.plot}</p>
            )}

            {movie.director && (
              <p className="mt-2 text-xs text-slate-400 line-clamp-1">
                {t("settings.cancel") /* placeholder unused */ ? null : null}
                <span className="text-slate-500">Direção:</span> {movie.director}
              </p>
            )}
            {cast.length > 0 && (
              <p className="mt-1 text-xs text-slate-400 line-clamp-1">
                <span className="text-slate-500">Elenco:</span> {cast.slice(0, 6).join(", ")}
              </p>
            )}

            <div className="mt-5 flex flex-wrap gap-2 items-center">
              <button
                onClick={handlePlay}
                className="btn-primary !text-base !px-5 !py-2.5 shadow-lg shadow-accent/30"
              >
                <IconPlay />
                {hasProgress
                  ? `Continuar de ${formatTime(progress.position)}`
                  : "Assistir"}
              </button>
              {hasProgress && (
                <button onClick={handleRestart} className="btn-ghost">
                  <IconRetry />
                  Recomeçar
                </button>
              )}
              <button
                onClick={() => toggleFavorite(movie.id)}
                className={`btn-ghost ${isFav ? "!text-rose-300" : ""}`}
                title={isFav ? "Remover dos favoritos" : "Adicionar aos favoritos"}
              >
                <IconHeart fill={isFav ? "currentColor" : "none"} />
                {isFav ? "Favorito" : "Favoritar"}
              </button>
            </div>

            {hasProgress && (
              <div className="mt-3 max-w-md">
                <div className="h-1 bg-white/10 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-accent"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="text-[11px] text-slate-400 mt-1 tabular-nums">
                  {formatTime(progress.position)} / {formatTime(progress.duration)}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
