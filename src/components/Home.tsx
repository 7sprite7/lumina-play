import { useMemo } from "react";
import type { ComponentType, SVGProps } from "react";
import { useAppStore } from "../store";
import { useT } from "../lib/i18n";
import { IconFilm, IconMonitor, IconTv } from "./icons";

interface MenuCard {
  id: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  gradient: string;
  action: () => void;
  disabled: boolean;
  badge: string;
}

export default function Home() {
  const setView = useAppStore((s) => s.setView);
  const liveChannels = useAppStore((s) => s.liveChannels);
  const movies = useAppStore((s) => s.movies);
  const series = useAppStore((s) => s.series);
  const loading = useAppStore((s) => s.loading);
  const t = useT();

  const cards: MenuCard[] = useMemo(
    () => [
      {
        id: "live",
        label: t("home.live"),
        icon: IconTv,
        gradient: "from-indigo-500/50 to-blue-700/40",
        action: () => setView("live"),
        badge: String(liveChannels.length),
        disabled: liveChannels.length === 0,
      },
      {
        id: "movies",
        label: t("home.movies"),
        icon: IconFilm,
        gradient: "from-rose-500/50 to-red-700/40",
        action: () => setView("movies"),
        badge: String(movies.length),
        disabled: movies.length === 0,
      },
      {
        id: "series",
        label: t("home.series"),
        icon: IconMonitor,
        gradient: "from-fuchsia-500/50 to-purple-700/40",
        action: () => setView("series"),
        badge: String(series.length),
        disabled: series.length === 0,
      },
    ],
    [liveChannels.length, movies.length, series.length, setView, t]
  );

  return (
    <div className="flex-1 relative flex items-center justify-center p-6 overflow-hidden">
      <div
        className="absolute inset-0 bg-lumina-art opacity-60 pointer-events-none"
        aria-hidden
      />
      <div
        className="absolute inset-0 bg-gradient-to-b from-transparent via-black/20 to-black/50 pointer-events-none"
        aria-hidden
      />

      <div className="relative w-full max-w-5xl flex flex-wrap items-center justify-center gap-6">
        {cards.map((c) => {
          const Icon = c.icon;
          return (
            <button
              key={c.id}
              onClick={() => !c.disabled && c.action()}
              disabled={c.disabled}
              className={`group relative w-56 h-72 md:w-64 md:h-80 rounded-2xl overflow-hidden transition-all duration-300 ease-out ring-offset-2 ring-offset-bg-900 ${
                c.disabled
                  ? "opacity-50 cursor-not-allowed"
                  : "hover:scale-[1.04] hover:ring-2 hover:ring-accent hover:shadow-[0_25px_60px_-15px] hover:shadow-accent/40"
              }`}
            >
              <div className={`absolute inset-0 bg-gradient-to-br ${c.gradient}`} />
              <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/30 to-transparent" />

              <div className="absolute inset-0 flex flex-col items-center justify-center text-white/85 transition-transform duration-300 group-hover:scale-110">
                <Icon className="w-20 h-20 md:w-24 md:h-24 drop-shadow-lg" />
              </div>

              {!c.disabled && (
                <div className="absolute top-3 right-3 px-2 py-0.5 rounded-full bg-black/60 text-xs font-semibold tabular-nums">
                  {c.badge}
                </div>
              )}

              <div className="absolute bottom-0 left-0 right-0 p-4 text-center">
                <div className="font-bold uppercase tracking-wider text-sm md:text-base drop-shadow">
                  {c.label}
                </div>
                {c.disabled && (
                  <div className="text-[10px] text-slate-300 mt-1">{t("home.noContent")}</div>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {loading && (
        <div className="absolute bottom-8 text-slate-300 text-sm flex items-center gap-2">
          <span className="w-4 h-4 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" />
          {t("home.loadingCatalog")}
        </div>
      )}
    </div>
  );
}
