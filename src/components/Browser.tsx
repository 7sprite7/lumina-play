import { forwardRef, useDeferredValue, useMemo } from "react";
import { VirtuosoGrid } from "react-virtuoso";
import {
  useAppStore,
  getCategoriesFor,
  getItemsFor,
  applySort,
  hasAdultContent,
} from "../store";
import type { ContentType, LiveChannel, Movie, SeriesItem, SortBy } from "../types";
import Sidebar from "./Sidebar";
import MediaCard from "./MediaCard";
import ErrorBoundary from "./ErrorBoundary";
import { useT } from "../lib/i18n";
import { SearchIndex } from "../lib/search";
import {
  V_CAT,
  isInProgress,
  isRecentlyAdded,
  isVirtualCategory,
} from "../lib/virtual-categories";
import { IconFilm, IconMonitor, IconTv } from "./icons";

interface Props {
  type: ContentType;
  title: string;
}

export default function Browser({ type, title }: Props) {
  const liveChannels = useAppStore((s) => s.liveChannels);
  const movies = useAppStore((s) => s.movies);
  const series = useAppStore((s) => s.series);
  const selectedCategory = useAppStore((s) => s.selectedCategory);
  const searchQuery = useAppStore((s) => s.searchQuery);
  const sortBy = useAppStore((s) => s.sortBy);
  const setSortBy = useAppStore((s) => s.setSortBy);
  const loading = useAppStore((s) => s.loading);
  const error = useAppStore((s) => s.error);
  const playLive = useAppStore((s) => s.playLive);
  const openSeriesDetail = useAppStore((s) => s.openSeriesDetail);
  const openMovieDetail = useAppStore((s) => s.openMovieDetail);
  const settings = useAppStore((s) => s.settings);
  const adultUnlocked = useAppStore((s) => s.adultUnlocked);
  const favorites = useAppStore((s) => s.favorites);
  const watchProgress = useAppStore((s) => s.watchProgress);
  const liveRecent = useAppStore((s) => s.liveRecent);
  const t = useT();

  const SORT_LABELS: Record<SortBy, string> = {
    default: t("browser.sort.default"),
    az: t("browser.sort.az"),
    za: t("browser.sort.za"),
    recent: t("browser.sort.recent"),
  };

  const allowAll = true;

  const items = useMemo(() => {
    const state = { liveChannels, movies, series, settings, adultUnlocked } as any;
    return getItemsFor(state, type);
  }, [type, liveChannels, movies, series, settings, adultUnlocked]);

  const categories = useMemo(() => {
    const state = { liveChannels, movies, series, settings, adultUnlocked } as any;
    return getCategoriesFor(state, type);
  }, [type, liveChannels, movies, series, settings, adultUnlocked]);

  const hasAdult = useMemo(() => {
    const state = { liveChannels, movies, series, settings } as any;
    return hasAdultContent(state, type);
  }, [type, liveChannels, movies, series, settings]);

  const favSet = useMemo(() => new Set(favorites), [favorites]);

  const continueItems = useMemo(() => {
    if (type === "live") {
      // Live "recently watched": pick channels by descending last-play time.
      return items
        .filter((i) => liveRecent[i.id])
        .slice()
        .sort((a, b) => (liveRecent[b.id] ?? 0) - (liveRecent[a.id] ?? 0));
    }
    if (type === "series") {
      // Series tab: find series that have ANY episode in progress (via parentId).
      const seriesWithProgress = new Set<string>();
      const lastUpdatedBySeries = new Map<string, number>();
      for (const p of Object.values(watchProgress)) {
        if (p.contentType === "series" && p.parentId && isInProgress(p)) {
          seriesWithProgress.add(p.parentId);
          const prev = lastUpdatedBySeries.get(p.parentId) ?? 0;
          if (p.updatedAt > prev) lastUpdatedBySeries.set(p.parentId, p.updatedAt);
        }
      }
      return items
        .filter((i) => seriesWithProgress.has(i.id))
        .slice()
        .sort(
          (a, b) =>
            (lastUpdatedBySeries.get(b.id) ?? 0) - (lastUpdatedBySeries.get(a.id) ?? 0)
        );
    }
    return items.filter((i) => {
      const p = watchProgress[i.id];
      return p && isInProgress(p);
    });
  }, [items, watchProgress, type]);

  const favoritesItems = useMemo(
    () => items.filter((i) => favSet.has(i.id)),
    [items, favSet]
  );

  const recentItems = useMemo(() => {
    const filtered = items.filter(
      (i) => "addedAt" in i && isRecentlyAdded((i as any).addedAt)
    );
    // Sort newest first and cap to 100
    return filtered
      .slice()
      .sort((a, b) => ((b as any).addedAt ?? 0) - ((a as any).addedAt ?? 0))
      .slice(0, 100);
  }, [items]);

  // Apply category/virtual filter BEFORE search
  const byCategory = useMemo(() => {
    if (selectedCategory === V_CAT.CONTINUE) {
      if (type === "live") {
        // continueItems is already sorted by liveRecent timestamp desc
        return continueItems;
      }
      // continue items sorted by most recent VOD progress
      return [...continueItems].sort(
        (a, b) => (watchProgress[b.id]?.updatedAt ?? 0) - (watchProgress[a.id]?.updatedAt ?? 0)
      );
    }
    if (selectedCategory === V_CAT.FAVORITES) return favoritesItems;
    if (selectedCategory === V_CAT.RECENT) return recentItems;
    if (selectedCategory) return items.filter((i) => i.category === selectedCategory);
    return items;
  }, [items, selectedCategory, continueItems, favoritesItems, recentItems, watchProgress, type]);

  const searchIndex = useMemo(() => new SearchIndex(byCategory), [byCategory]);

  // Defer the search query so React can keep the input responsive while
  // filtering 22k+ items. Without this the main thread stalls on every
  // keystroke and the WebView shows a black frame for hundreds of ms — on
  // some panels long enough to look like a crash.
  const deferredQuery = useDeferredValue(searchQuery);

  const filtered = useMemo(() => {
    const q = deferredQuery.trim();
    const base = q ? searchIndex.search(q) : byCategory;
    if (!q || sortBy !== "default") return applySort(base, sortBy);
    return base;
  }, [byCategory, searchIndex, deferredQuery, sortBy]);

  const handleItemClick = (item: LiveChannel | Movie | SeriesItem) => {
    if (item.contentType === "live") {
      // Pass the current filtered list as the "queue" so the Player
      // can navigate with prev/next buttons.
      const liveList = filtered.filter(
        (i): i is LiveChannel => i.contentType === "live"
      );
      playLive(item, liveList);
    } else if (item.contentType === "movie") openMovieDetail(item);
    else openSeriesDetail(item);
  };

  const EmptyIcon = type === "movie" ? IconFilm : type === "series" ? IconMonitor : IconTv;
  const aspect = type === "live" ? "aspect-video" : "aspect-[2/3]";
  const minCard = type === "live" ? 160 : 140;

  // (VirtualGrid defined below — renders only cards in the viewport plus a small
  // buffer, so a 22k-item list behaves like a 60-item list in the DOM.)

  const continueLabel = type === "live" ? t("sidebar.liveRecent") : t("sidebar.continue");

  const currentCategoryLabel = isVirtualCategory(selectedCategory)
    ? selectedCategory === V_CAT.CONTINUE
      ? continueLabel
      : selectedCategory === V_CAT.FAVORITES
      ? t("sidebar.favorites")
      : t("sidebar.recent")
    : selectedCategory;

  return (
    <div className="flex-1 flex min-h-0">
      <Sidebar
        categories={categories}
        totalCount={items.length}
        title={title}
        allowAll={allowAll}
        hasAdultLocked={hasAdult && settings.adultPinHash !== null && !adultUnlocked}
        hasAdultUnlocked={hasAdult && settings.adultPinHash !== null && adultUnlocked}
        continueCount={continueItems.length}
        continueLabel={continueLabel}
        favoritesCount={favoritesItems.length}
        recentCount={recentItems.length}
        preserveCategoryOrder={type === "live"}
        adultExtras={settings.adultCategoriesExtra}
      />

      <div className="flex-1 flex flex-col min-w-0">
        <div className="px-6 py-3 border-b border-white/5 flex items-center gap-3 flex-wrap">
          <h2 className="font-semibold text-lg">{title}</h2>
          <span className="text-xs text-slate-400 tabular-nums">
            {t(filtered.length === 1 ? "browser.count.one" : "browser.count.many", {
              count: filtered.length,
            })}
            {currentCategoryLabel ? ` · ${currentCategoryLabel}` : ""}
          </span>

          <div className="flex-1" />

          <div className="flex items-center gap-1 bg-white/5 rounded-lg p-0.5">
            {(Object.keys(SORT_LABELS) as SortBy[]).map((s) => (
              <button
                key={s}
                onClick={() => setSortBy(s)}
                className={`px-3 py-1 text-xs rounded-md transition-colors ${
                  sortBy === s ? "bg-accent text-white" : "text-slate-300 hover:bg-white/5"
                }`}
              >
                {SORT_LABELS[s]}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center text-slate-400">
            {t("browser.loading")}
          </div>
        ) : error ? (
          <div className="flex-1 flex items-center justify-center text-red-400 px-6 text-center">
            {error}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-slate-500 gap-2">
            <EmptyIcon className="w-12 h-12 opacity-30" />
            <p>{t("browser.noItems")}</p>
          </div>
        ) : (
          <ErrorBoundary>
            <VirtualGrid
              items={filtered}
              minCardWidth={minCard}
              aspectClass={aspect}
              onItemClick={handleItemClick}
            />
          </ErrorBoundary>
        )}
      </div>
    </div>
  );
}

interface VirtualGridProps {
  items: Array<LiveChannel | Movie | SeriesItem>;
  minCardWidth: number;
  aspectClass: string;
  onItemClick: (item: LiveChannel | Movie | SeriesItem) => void;
}

function VirtualGrid({ items, minCardWidth, aspectClass, onItemClick }: VirtualGridProps) {
  const ListComponent = useMemo(
    () =>
      forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function List(
        props,
        ref
      ) {
        return (
          <div
            ref={ref}
            {...props}
            className="grid gap-3 p-4"
            style={{
              gridTemplateColumns: `repeat(auto-fill, minmax(${minCardWidth}px, 1fr))`,
              ...props.style,
            }}
          />
        );
      }),
    [minCardWidth]
  );

  const ItemComponent = useMemo(
    () =>
      function Item(props: React.HTMLAttributes<HTMLDivElement>) {
        return <div {...props} className="w-full" style={{ ...props.style }} />;
      },
    []
  );

  return (
    <VirtuosoGrid
      className="flex-1"
      style={{ height: "100%" }}
      totalCount={items.length}
      overscan={600}
      increaseViewportBy={{ top: 300, bottom: 600 }}
      components={{ List: ListComponent, Item: ItemComponent }}
      itemContent={(index) => {
        const it = items[index];
        if (!it) return null;
        return (
          <MediaCard
            item={it}
            aspectClass={aspectClass}
            onClick={() => onItemClick(it)}
          />
        );
      }}
    />
  );
}
