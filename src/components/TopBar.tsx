import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../store";
import { useT } from "../lib/i18n";
import { formatDate, formatTime } from "../lib/datetime";
import {
  IconArrowLeft,
  IconCheck,
  IconChevronRight,
  IconGear,
  IconRefresh,
  IconServer,
  IconWifi,
} from "./icons";

function formatAge(ts: number | null): string {
  if (!ts) return "";
  const ms = Date.now() - ts;
  const min = Math.round(ms / 60000);
  if (min < 1) return "agora";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export default function TopBar() {
  const view = useAppStore((s) => s.view);
  const goBack = useAppStore((s) => s.goBack);
  const setView = useAppStore((s) => s.setView);
  const sources = useAppStore((s) => s.sources);
  const activeSourceId = useAppStore((s) => s.activeSourceId);
  const setActiveSource = useAppStore((s) => s.setActiveSource);
  const settings = useAppStore((s) => s.settings);
  const refreshing = useAppStore((s) => s.refreshing);
  const loading = useAppStore((s) => s.loading);
  const cacheAt = useAppStore((s) => s.cacheAt);
  const refreshContent = useAppStore((s) => s.refreshContent);
  const activeSource = sources.find((s) => s.id === activeSourceId);
  const t = useT();
  const busy = refreshing || loading;

  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const i = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(i);
  }, []);

  const [switcherOpen, setSwitcherOpen] = useState(false);
  const switcherRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!switcherOpen) return;
    const onClick = (e: MouseEvent) => {
      if (switcherRef.current && !switcherRef.current.contains(e.target as Node)) {
        setSwitcherOpen(false);
      }
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [switcherOpen]);

  const time = formatTime(now, settings.timeFormat);
  const date = formatDate(now, settings.dateFormat, settings.language);

  const canGoBack = view !== "home";

  return (
    <header className="h-16 px-6 flex items-center gap-4 bg-gradient-to-b from-black/40 to-transparent backdrop-blur-sm relative z-10">
      {canGoBack ? (
        <button
          onClick={goBack}
          className="btn-ghost !bg-white/5 hover:!bg-white/10"
          aria-label={t("app.back")}
        >
          <IconArrowLeft />
          <span className="hidden sm:inline">{t("app.back")}</span>
        </button>
      ) : (
        <div className="flex items-center gap-2.5 font-bold tracking-tight">
          <img
            src="/lumina-logo.png"
            alt=""
            className="w-8 h-8 object-contain"
            onError={(e) => ((e.currentTarget.style.display = "none"))}
          />
          <span className="text-lg">
            <span className="text-sky-300">LÚMINA</span>
            <span className="text-amber-300 ml-1.5">PLAY</span>
          </span>
        </div>
      )}

      <div className="flex-1" />

      <div className="text-center leading-tight">
        <div className="font-semibold tabular-nums">{time}</div>
        <div className="text-[11px] text-slate-400 tabular-nums">{date}</div>
      </div>

      <div className="flex-1" />

      <button
        onClick={() => refreshContent()}
        disabled={busy || !activeSource}
        className="btn-ghost disabled:opacity-50"
        title={
          busy
            ? t("sidebar.refreshing")
            : cacheAt
            ? `${t("sidebar.refresh")} · ${formatAge(cacheAt)}`
            : t("sidebar.refresh")
        }
        aria-label={t("sidebar.refresh")}
      >
        <IconRefresh className={busy ? "animate-spin" : ""} />
      </button>

      <button
        onClick={() => setView("preferences")}
        className="btn-ghost"
        title={t("settings.preferences")}
        aria-label={t("settings.preferences")}
      >
        <IconGear />
      </button>

      <div ref={switcherRef} className="relative">
        <button
          onClick={() => setSwitcherOpen((v) => !v)}
          className="btn-ghost"
          title={t("app.switchSource")}
        >
          <IconServer />
          <IconWifi className={activeSource ? "text-emerald-400" : "text-slate-500"} />
          <span className="max-w-[160px] truncate hidden sm:inline">
            {activeSource ? activeSource.name : t("app.sourceNone")}
          </span>
          <IconChevronRight className={`transition-transform ${switcherOpen ? "rotate-90" : ""}`} />
        </button>

        {switcherOpen && (
          <div className="absolute right-0 top-full mt-2 w-72 bg-black/95 backdrop-blur border border-white/10 rounded-xl shadow-2xl z-30 overflow-hidden">
            <div className="px-3 py-2 border-b border-white/10 text-xs text-slate-400 uppercase tracking-wide">
              {t("app.changeSource")}
            </div>
            <div className="max-h-64 overflow-y-auto py-1">
              {sources.length === 0 && (
                <div className="px-3 py-3 text-sm text-slate-500">
                  {t("settings.noSources")}
                </div>
              )}
              {sources.map((s) => {
                const active = s.id === activeSourceId;
                return (
                  <button
                    key={s.id}
                    onClick={() => {
                      if (!active) setActiveSource(s.id);
                      setSwitcherOpen(false);
                    }}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-white/5 ${
                      active ? "text-accent" : "text-slate-200"
                    }`}
                  >
                    <span className="w-4">{active ? <IconCheck /> : null}</span>
                    <div className="flex-1 min-w-0">
                      <div className="truncate">{s.name}</div>
                      <div className="text-[11px] text-slate-500 truncate">
                        {s.type === "m3u" ? s.url : `${s.host} · ${s.username}`}
                      </div>
                    </div>
                    <span className="text-[10px] uppercase tracking-wider text-slate-500">
                      {s.type}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="border-t border-white/10">
              <button
                onClick={() => {
                  setSwitcherOpen(false);
                  setView("settings");
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-300 hover:bg-white/5"
              >
                <IconGear />
                {t("app.manageSources")}
              </button>
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
