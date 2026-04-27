import { useMemo, useState } from "react";
import { useAppStore } from "../store";
import type { Category } from "../types";
import { useT } from "../lib/i18n";
import { V_CAT, sortCategoriesForSidebar } from "../lib/virtual-categories";
import { isAdultCategory } from "../lib/adult-detector";
import {
  IconClock,
  IconHeart,
  IconList,
  IconLock,
  IconRefresh,
  IconSearch,
  IconSparkle,
  IconUnlock,
} from "./icons";

interface Props {
  categories: Category[];
  totalCount: number;
  title: string;
  allowAll?: boolean;
  hasAdultLocked?: boolean;
  hasAdultUnlocked?: boolean;
  continueCount?: number;
  // Custom label for the "continue" virtual category — used by the live tab
  // to show "Assistidos recentemente" instead of "Continuar assistindo".
  continueLabel?: string;
  favoritesCount?: number;
  recentCount?: number;
  // When true, render categories in the order they were given (no sidebar
  // re-ranking by count or by Cinema/Lançamentos heuristics). Used by the
  // live tab so the channel-group order matches the source playlist.
  preserveCategoryOrder?: boolean;
  // User-defined adult category names (settings.adultCategoriesExtra). Used
  // together with the built-in keyword detector to push adult categories to
  // the end of the list — so they only show up after every other category.
  adultExtras?: string[];
}

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

export default function Sidebar({
  categories,
  totalCount,
  title,
  allowAll = true,
  hasAdultLocked = false,
  hasAdultUnlocked = false,
  continueCount = 0,
  continueLabel,
  favoritesCount = 0,
  recentCount = 0,
  preserveCategoryOrder = false,
  adultExtras,
}: Props) {
  const selectedCategory = useAppStore((s) => s.selectedCategory);
  const setSelectedCategory = useAppStore((s) => s.setSelectedCategory);
  const searchQuery = useAppStore((s) => s.searchQuery);
  const setSearchQuery = useAppStore((s) => s.setSearchQuery);
  const refreshing = useAppStore((s) => s.refreshing);
  const loading = useAppStore((s) => s.loading);
  const refreshContent = useAppStore((s) => s.refreshContent);
  const cacheAt = useAppStore((s) => s.cacheAt);
  const unlockAdult = useAppStore((s) => s.unlockAdult);
  const lockAdult = useAppStore((s) => s.lockAdult);
  const t = useT();

  const busy = refreshing || loading;

  const [promptPin, setPromptPin] = useState(false);
  const [pinInput, setPinInput] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);

  const doUnlock = async () => {
    const ok = await unlockAdult(pinInput);
    if (ok) {
      setPromptPin(false);
      setPinInput("");
      setPinError(null);
    } else {
      setPinError(t("sidebar.pinIncorrect"));
    }
  };

  const sortedCategories = useMemo(() => {
    const base = preserveCategoryOrder
      ? categories
      : sortCategoriesForSidebar(categories);
    // Always push adult categories to the very end while keeping their
    // relative order intact — applies to both source-order (live) and the
    // sidebar-sorted (movies/series) paths. When a PIN is set and the user
    // hasn't unlocked, the upstream filter already removed them, so this is
    // a no-op in that case.
    const nonAdult: Category[] = [];
    const adult: Category[] = [];
    for (const c of base) {
      if (isAdultCategory(c.name, adultExtras)) adult.push(c);
      else nonAdult.push(c);
    }
    return adult.length === 0 ? base : [...nonAdult, ...adult];
  }, [categories, preserveCategoryOrder, adultExtras]);

  return (
    <aside className="w-64 shrink-0 h-full bg-bg-800/80 backdrop-blur border-r border-white/5 flex flex-col">
      <div className="p-3 border-b border-white/5">
        <div className="relative">
          <IconSearch className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("sidebar.searchIn", { title: title.toLowerCase() })}
            className="input pl-9"
          />
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto p-2 space-y-0.5">
        {allowAll && (
          <CategoryButton
            label={t("sidebar.all")}
            count={totalCount}
            active={selectedCategory === null}
            onClick={() => setSelectedCategory(null)}
            icon={<IconList />}
          />
        )}

        {continueCount > 0 && (
          <CategoryButton
            label={continueLabel ?? t("sidebar.continue")}
            count={continueCount}
            active={selectedCategory === V_CAT.CONTINUE}
            onClick={() => setSelectedCategory(V_CAT.CONTINUE)}
            icon={<IconClock />}
            accentColor="text-amber-300"
          />
        )}

        {favoritesCount > 0 && (
          <CategoryButton
            label={t("sidebar.favorites")}
            count={favoritesCount}
            active={selectedCategory === V_CAT.FAVORITES}
            onClick={() => setSelectedCategory(V_CAT.FAVORITES)}
            icon={<IconHeart />}
            accentColor="text-rose-300"
          />
        )}

        {recentCount > 0 && (
          <CategoryButton
            label={t("sidebar.recent")}
            count={recentCount}
            active={selectedCategory === V_CAT.RECENT}
            onClick={() => setSelectedCategory(V_CAT.RECENT)}
            icon={<IconSparkle />}
            accentColor="text-sky-300"
          />
        )}

        {(allowAll || continueCount > 0 || favoritesCount > 0 || recentCount > 0) && (
          <div className="h-px bg-white/5 my-2" />
        )}

        {sortedCategories.map((c) => (
          <CategoryButton
            key={c.name}
            label={c.name}
            count={c.count}
            active={selectedCategory === c.name}
            onClick={() => setSelectedCategory(c.name)}
          />
        ))}
        {sortedCategories.length === 0 && (
          <p className="text-xs text-slate-500 px-2 py-3">{t("sidebar.noCategories")}</p>
        )}
      </nav>

      {(hasAdultLocked || hasAdultUnlocked) && (
        <div className="border-t border-white/5 p-2">
          {hasAdultLocked && !promptPin && (
            <button
              onClick={() => setPromptPin(true)}
              className="w-full btn-ghost text-xs text-amber-300"
            >
              <IconLock />
              <span className="flex-1 text-left">{t("sidebar.unlockAdult")}</span>
            </button>
          )}

          {hasAdultLocked && promptPin && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                doUnlock();
              }}
              className="space-y-2 p-1"
            >
              <input
                type="password"
                autoFocus
                inputMode="numeric"
                maxLength={12}
                value={pinInput}
                onChange={(e) => {
                  setPinInput(e.target.value);
                  setPinError(null);
                }}
                placeholder={t("sidebar.pinPlaceholder")}
                className="input text-center tabular-nums"
              />
              {pinError && <div className="text-[11px] text-red-400 text-center">{pinError}</div>}
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => {
                    setPromptPin(false);
                    setPinInput("");
                    setPinError(null);
                  }}
                  className="btn-ghost flex-1 text-xs"
                >
                  {t("sidebar.cancel")}
                </button>
                <button type="submit" className="btn-primary flex-1 text-xs">
                  {t("sidebar.ok")}
                </button>
              </div>
            </form>
          )}

          {hasAdultUnlocked && (
            <button
              onClick={() => lockAdult()}
              className="w-full btn-ghost text-xs text-emerald-300"
            >
              <IconUnlock />
              <span className="flex-1 text-left">{t("sidebar.lockAdult")}</span>
            </button>
          )}
        </div>
      )}

      <div className="border-t border-white/5 px-2 py-1.5 flex items-center gap-1.5">
        <button
          onClick={() => refreshContent()}
          disabled={busy}
          className="btn-ghost !px-2 !py-1 text-xs disabled:opacity-50"
          title={t("sidebar.refreshHint")}
          aria-label={t("sidebar.refresh")}
        >
          <IconRefresh className={busy ? "animate-spin" : ""} />
        </button>
        <span className="text-[10px] text-slate-500 tabular-nums flex-1 text-right">
          {busy ? t("sidebar.refreshing") : cacheAt ? formatAge(cacheAt) : ""}
        </span>
      </div>
    </aside>
  );
}

function CategoryButton({
  label,
  count,
  active,
  onClick,
  icon,
  accentColor,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  icon?: React.ReactNode;
  accentColor?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 rounded-md px-2.5 py-2 text-sm transition-colors text-left ${
        active ? "bg-accent text-white" : `${accentColor ?? "text-slate-300"} hover:bg-white/5`
      }`}
    >
      {icon}
      <span className="flex-1 truncate">{label}</span>
      <span
        className={`text-[10px] tabular-nums px-1.5 py-0.5 rounded ${
          active ? "bg-white/20" : "bg-white/5 text-slate-400"
        }`}
      >
        {count}
      </span>
    </button>
  );
}
