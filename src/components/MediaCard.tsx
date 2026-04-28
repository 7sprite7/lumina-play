import type { LiveChannel, Movie, SeriesItem } from "../types";
import { useAppStore } from "../store";
import { IconFilm, IconHeart, IconMonitor, IconPlay, IconStar, IconTv } from "./icons";

interface Props {
  item: LiveChannel | Movie | SeriesItem;
  aspectClass?: string;
  onClick: () => void;
}

// Uniform card: whole card has a fixed aspect ratio so the grid renders evenly.
// Movie/series: 2:3 poster fills the card, title overlays the bottom with a gradient.
// Live: 16:9 card, logo centered, title overlay.
export default function MediaCard({ item, aspectClass = "aspect-video", onClick }: Props) {
  const favorites = useAppStore((s) => s.favorites);
  const toggleFavorite = useAppStore((s) => s.toggleFavorite);
  const watchProgress = useAppStore((s) => s.watchProgress);

  const Fallback =
    item.contentType === "movie" ? IconFilm : item.contentType === "series" ? IconMonitor : IconTv;
  const isPoster = aspectClass.includes("2/3");

  const rating = "rating" in item ? item.rating : undefined;
  const year = "year" in item ? item.year : undefined;
  const isFav = favorites.includes(item.id);
  // Live channels can be favourited too — they show in the "Favoritos"
  // virtual category in the live tab.
  const canFavorite = true;
  const progress = watchProgress[item.id];
  const logo = item.logo;
  const showProgress =
    progress &&
    progress.duration > 0 &&
    progress.position > 5 &&
    progress.position < progress.duration * 0.95;
  const pct = showProgress ? Math.min(100, (progress.position / progress.duration) * 100) : 0;

  return (
    // role="button" instead of <button> because the favorite heart inside is
    // a real <button>, and nested buttons are invalid HTML — that nesting
    // was triggering a recursion in react-virtuoso when the dataset got
    // rebuilt rapidly during search, eventually `RangeError: Maximum call
    // stack size exceeded` and a black-screen.
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className={`group ${aspectClass} relative w-full text-left bg-bg-900 border border-white/5 rounded-xl overflow-hidden hover:border-accent hover:shadow-[0_12px_30px_-10px] hover:shadow-accent/40 hover:-translate-y-0.5 transition-all cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent`}
    >
      {/* Poster / logo */}
      {logo ? (
        <img
          key={logo}
          src={logo}
          alt=""
          className={
            isPoster
              ? "absolute inset-0 w-full h-full object-cover"
              : "absolute inset-0 m-auto max-w-[70%] max-h-[70%] object-contain"
          }
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={(e) => ((e.currentTarget.style.display = "none"))}
        />
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <Fallback className="w-10 h-10 text-slate-600" />
        </div>
      )}

      {/* Bottom gradient + title overlay (always fixed height so cards stay uniform) */}
      <div className="absolute inset-x-0 bottom-0 p-2 pt-8 bg-gradient-to-t from-black/95 via-black/70 to-transparent">
        <div className="text-sm font-medium leading-tight line-clamp-2 drop-shadow">
          {item.name}
        </div>
        <div className="text-[11px] text-slate-400 mt-0.5 truncate">
          {year ? `${year} · ` : ""}
          {item.category}
        </div>
      </div>

      {/* Rating badge */}
      {rating !== undefined && rating > 0 && (
        <div className="absolute top-2 left-2 bg-black/70 backdrop-blur-sm rounded px-1.5 py-0.5 text-[11px] flex items-center gap-1">
          <IconStar className="w-3 h-3 text-amber-400" />
          <span className="tabular-nums">{rating.toFixed(1)}</span>
        </div>
      )}

      {/* Favorite button (movies/series only) */}
      {canFavorite && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            toggleFavorite(item.id);
          }}
          className={`absolute top-2 right-2 w-7 h-7 rounded-full flex items-center justify-center transition-colors backdrop-blur-sm ${
            isFav
              ? "bg-rose-500 text-white"
              : "bg-black/50 text-slate-200 opacity-0 group-hover:opacity-100 hover:bg-rose-500/70"
          }`}
          aria-label={isFav ? "Remover dos favoritos" : "Adicionar aos favoritos"}
          title={isFav ? "Remover dos favoritos" : "Adicionar aos favoritos"}
        >
          <IconHeart className="w-3.5 h-3.5" fill={isFav ? "currentColor" : "none"} />
        </button>
      )}

      {/* Hover play icon */}
      <div className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
        <div className="bg-accent text-white rounded-full p-3 shadow-xl">
          <IconPlay />
        </div>
      </div>

      {/* Watch progress bar */}
      {showProgress && (
        <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/60">
          <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}
