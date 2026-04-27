import { create } from "zustand";
import type {
  LiveChannel,
  Movie,
  SeriesItem,
  Episode,
  Source,
  Category,
  View,
  ContentType,
  PlaybackItem,
  SortBy,
  AppSettings,
  WatchProgress,
} from "./types";
import {
  loadSources,
  saveSources,
  loadActiveSourceId,
  saveActiveSourceId,
  loadSettings,
  saveSettings,
  loadFavorites,
  saveFavorites,
  loadWatchProgress,
  saveWatchProgress,
  loadLiveRecent,
  saveLiveRecent,
} from "./lib/storage";
import { parseM3U } from "./lib/m3u-parser";
import { fetchText } from "./lib/http";
import { parseXmltv, programsAround, type EpgIndex } from "./lib/xmltv-parser";
import { loadEpg, saveEpg, isEpgFresh } from "./lib/epg-cache";
import {
  loadXtreamLive,
  loadXtreamMovies,
  loadXtreamSeriesList,
  loadXtreamSeriesInfo,
  loadXtreamShortEpg,
  loadXtreamMovieInfo,
} from "./lib/xtream-api";
import type { EpgProgram } from "./types";
import { loadCache, saveCache, clearCache, isFresh, type ContentCache } from "./lib/cache";
import { sha256Hex } from "./lib/crypto";
import { isAdultCategory } from "./lib/adult-detector";
import { effectiveXtreamSource } from "./lib/xtream-detect";

interface AppState {
  sources: Source[];
  activeSourceId: string | null;

  liveChannels: LiveChannel[];
  movies: Movie[];
  series: SeriesItem[];

  cacheAt: number | null;

  view: View;
  previousView: View;
  selectedSeries: SeriesItem | null;
  selectedMovie: Movie | null;
  selectedCategory: string | null;
  searchQuery: string;
  sortBy: SortBy;

  settings: AppSettings;
  adultUnlocked: boolean;

  favorites: string[];
  watchProgress: Record<string, WatchProgress>;
  // Live channel "recently watched": channelId -> last play timestamp.
  liveRecent: Record<string, number>;

  // EPG (programme guide) data for the active source. Indexed by `tvg-id` →
  // sorted list of programmes. Populated for M3U sources from XMLTV (the
  // source's `epgUrl`); empty for Xtream sources because those use the
  // `get_short_epg` API on demand instead.
  epgIndex: EpgIndex;

  // Live queue: lets the Player navigate prev/next without going back to the menu.
  liveQueue: LiveChannel[];
  liveQueueIndex: number;
  currentEpg: EpgProgram[];
  epgLoading: boolean;

  playback: PlaybackItem | null;

  loading: boolean;
  refreshing: boolean;
  error: string | null;

  // True once init() has finished loading persisted state from disk. Components
  // (e.g. App.tsx) use this to avoid taking action based on the empty initial
  // state — without it, App switches to the SourceManager view before the
  // saved source list has been loaded, which strands the user there even when
  // a valid `activeSourceId` exists.
  bootstrapped: boolean;

  init: () => Promise<void>;
  addSource: (s: Source) => Promise<void>;
  removeSource: (id: string) => Promise<void>;
  updateSource: (s: Source) => Promise<void>;
  setActiveSource: (id: string) => Promise<void>;
  loadContent: (opts?: { force?: boolean }) => Promise<void>;
  refreshContent: () => Promise<void>;

  setView: (v: View) => void;
  goBack: () => void;
  openSeriesDetail: (series: SeriesItem) => Promise<void>;
  openMovieDetail: (movie: Movie) => Promise<void>;

  setSelectedCategory: (name: string | null) => void;
  setSearchQuery: (q: string) => void;
  setSortBy: (sort: SortBy) => void;

  setAdultPin: (pin: string | null) => Promise<void>;
  unlockAdult: (pin: string) => Promise<boolean>;
  lockAdult: () => void;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  markOnboarded: () => Promise<void>;

  toggleFavorite: (id: string) => Promise<void>;
  saveProgress: (entry: WatchProgress) => Promise<void>;
  clearProgress: (id: string) => Promise<void>;

  playLive: (c: LiveChannel, queue?: LiveChannel[]) => void;
  playMovie: (m: Movie) => void;
  playEpisode: (ep: Episode, series: SeriesItem) => void;
  stopPlayback: () => void;
  nextLive: () => void;
  prevLive: () => void;
  // Series episode navigation (returns true if there was a next/prev to play).
  nextEpisode: () => boolean;
  prevEpisode: () => boolean;
}

// Resolve the currently-playing episode + its neighbours within the parent
// series (across seasons). Returns null when not playing a series, when the
// series is missing seasons, or when the current episode can't be found.
//
// Takes the two slices it needs (playback + series list) directly so callers
// can pass them through `useMemo` and avoid creating a fresh object on every
// store notification (which would defeat Zustand's reference equality and
// cause render loops via useSyncExternalStore).
export function findEpisodeNeighbors(
  playback: AppState["playback"],
  seriesList: SeriesItem[]
): { series: SeriesItem; current: Episode; prev: Episode | null; next: Episode | null } | null {
  if (
    !playback ||
    playback.contentType !== "series" ||
    !playback.parentId ||
    !playback.itemId
  ) {
    return null;
  }
  const found = seriesList.find((s) => s.id === playback.parentId);
  if (!found?.seasons || found.seasons.length === 0) return null;
  const flat: Episode[] = [];
  for (const s of found.seasons) for (const ep of s.episodes) flat.push(ep);
  const idx = flat.findIndex((e) => e.id === playback.itemId);
  if (idx < 0) return null;
  return {
    series: found,
    current: flat[idx],
    prev: idx > 0 ? flat[idx - 1] : null,
    next: idx < flat.length - 1 ? flat[idx + 1] : null,
  };
}

function buildCategories<T extends { category: string }>(
  items: T[],
  opts: { preserveOrder?: boolean } = {}
): Category[] {
  const counts = new Map<string, number>();
  // Map preserves insertion order, so iterating items in their source order
  // gives us the natural "as-listed" sequence of categories.
  for (const it of items) counts.set(it.category, (counts.get(it.category) ?? 0) + 1);
  const list = Array.from(counts.entries()).map(([name, count]) => ({ name, count }));
  if (opts.preserveOrder) return list;
  return list.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "pt-BR"));
}

function filterAdult<T extends { category: string }>(
  items: T[],
  settings: AppSettings,
  unlocked: boolean
): T[] {
  if (unlocked || !settings.adultPinHash) return items;
  return items.filter(
    (item) => !isAdultCategory(item.category, settings.adultCategoriesExtra)
  );
}

export function getCategoriesFor(state: AppState, type: ContentType): Category[] {
  const items = getItemsFor(state, type);
  const visible = filterAdult(items, state.settings, state.adultUnlocked);
  // Live: keep the source order (the M3U/Xtream provider already curates it,
  // and the user expects the same sequence they see in the playlist).
  // Movies/Series: count-desc (popular categories first).
  return buildCategories(visible, { preserveOrder: type === "live" });
}

export function getItemsFor(state: AppState, type: ContentType): Array<LiveChannel | Movie | SeriesItem> {
  let raw: Array<LiveChannel | Movie | SeriesItem>;
  if (type === "live") raw = state.liveChannels;
  else if (type === "movie") raw = state.movies;
  else raw = state.series;
  return filterAdult(raw, state.settings, state.adultUnlocked);
}

export function hasAdultContent(state: AppState, type: ContentType): boolean {
  const raw = type === "live" ? state.liveChannels : type === "movie" ? state.movies : state.series;
  return raw.some((item) => isAdultCategory(item.category, state.settings.adultCategoriesExtra));
}

export function applySort<T extends { name: string; addedAt?: number; order?: number }>(
  items: T[],
  sort: SortBy
): T[] {
  if (sort === "default") return items;
  // Attach array index so we always have a stable tiebreaker / fallback
  const indexed = items.map((item, i) => ({ item, i }));
  if (sort === "az") {
    indexed.sort((a, b) => a.item.name.localeCompare(b.item.name, "pt-BR"));
    return indexed.map((x) => x.item);
  }
  if (sort === "za") {
    indexed.sort((a, b) => b.item.name.localeCompare(a.item.name, "pt-BR"));
    return indexed.map((x) => x.item);
  }
  // recent: newest first. Items with addedAt first (sorted desc), then items without
  // using order desc, and finally array index desc as last resort so the sort is
  // always visibly different from the default order.
  indexed.sort((a, b) => {
    const ax = a.item.addedAt;
    const bx = b.item.addedAt;
    const aHas = typeof ax === "number" && ax > 0;
    const bHas = typeof bx === "number" && bx > 0;
    if (aHas && bHas && ax !== bx) return (bx as number) - (ax as number);
    if (aHas && !bHas) return -1;
    if (bHas && !aHas) return 1;
    const ao = a.item.order ?? a.i;
    const bo = b.item.order ?? b.i;
    return bo - ao;
  });
  return indexed.map((x) => x.item);
}

interface FreshContent {
  liveChannels: LiveChannel[];
  movies: Movie[];
  series: SeriesItem[];
  // EPG/XMLTV URL auto-detected from the M3U `#EXTM3U url-tvg=...` header.
  // Caller persists it onto the source if the user hasn't already set one.
  detectedEpgUrl?: string;
}

async function fetchFresh(source: Source): Promise<FreshContent> {
  // Xtream-flavored M3U URLs (.../get.php?username=X&password=Y) carry the same
  // credentials the panel uses for its API. When detected, prefer the Xtream
  // API — it provides covers, plots, cast and ratings that bare M3U lacks.
  const xtream = effectiveXtreamSource(source);
  if (xtream) {
    const [live, movies, series] = await Promise.all([
      loadXtreamLive(xtream).catch(() => null),
      loadXtreamMovies(xtream).catch(() => [] as Movie[]),
      loadXtreamSeriesList(xtream).catch(() => [] as SeriesItem[]),
    ]);
    if (live !== null) {
      return { liveChannels: live, movies, series };
    }
    // Xtream API was unreachable — fall back to plain M3U if applicable.
  }

  if (source.type === "m3u") {
    const text = await fetchText(source.url);
    const parsed = parseM3U(text);
    return {
      liveChannels: parsed.live,
      movies: parsed.movies,
      series: parsed.series,
      detectedEpgUrl: parsed.epgUrl,
    };
  }

  // Direct Xtream source whose API failed: re-throw with empty result so the
  // caller surfaces an error.
  const [live, movies, series] = await Promise.all([
    loadXtreamLive(source),
    loadXtreamMovies(source).catch(() => [] as Movie[]),
    loadXtreamSeriesList(source).catch(() => [] as SeriesItem[]),
  ]);
  return { liveChannels: live, movies, series };
}

function applyCache(cache: ContentCache) {
  return {
    liveChannels: cache.liveChannels,
    movies: cache.movies,
    series: cache.series,
    cacheAt: cache.timestamp,
  };
}

export const useAppStore = create<AppState>((set, get) => ({
  sources: [],
  activeSourceId: null,

  liveChannels: [],
  movies: [],
  series: [],
  cacheAt: null,

  view: "home",
  previousView: "home",
  selectedSeries: null,
  selectedMovie: null,
  selectedCategory: null,
  searchQuery: "",
  sortBy: "default",

  settings: {
    adultPinHash: null,
    adultCategoriesExtra: [],
    language: "pt",
    theme: "classic",
    dateFormat: "ddmmyyyy",
    timeFormat: "24h",
    showEpg: false,
    hasOnboarded: false,
  },
  adultUnlocked: false,

  favorites: [],
  watchProgress: {},
  liveRecent: {},
  epgIndex: {},

  liveQueue: [],
  liveQueueIndex: -1,
  currentEpg: [],
  epgLoading: false,

  playback: null,

  loading: false,
  refreshing: false,
  error: null,
  bootstrapped: false,

  async init() {
    const [sources, activeSourceId, settings, favorites, watchProgress, liveRecent] =
      await Promise.all([
        loadSources(),
        loadActiveSourceId(),
        loadSettings(),
        loadFavorites(),
        loadWatchProgress(),
        loadLiveRecent(),
      ]);
    set({
      sources,
      activeSourceId,
      settings,
      adultUnlocked: !settings.adultPinHash,
      favorites,
      watchProgress,
      liveRecent,
      bootstrapped: true,
    });
    if (activeSourceId && sources.find((s) => s.id === activeSourceId)) {
      await get().loadContent();
    } else if (sources.length === 0) {
      set({ view: "settings" });
    }

    // Auto-refresh every 12h. The catalog cache TTL is also 12h, so this
    // matches: when the timer fires, `refreshContent` busts the cache and
    // pulls a fresh copy from the provider. Skip if no active source or
    // a refresh is already in flight.
    if (typeof window !== "undefined") {
      const TWELVE_HOURS = 12 * 60 * 60 * 1000;
      window.setInterval(() => {
        const s = get();
        if (!s.activeSourceId) return;
        if (s.loading || s.refreshing) return;
        if (s.playback) return; // don't tug the rug while user is watching
        s.refreshContent().catch(() => {});
      }, TWELVE_HOURS);

      // Also refresh on tab/focus return when cache is stale (covers laptops
      // that were sleeping or phones that backgrounded the app for hours).
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible") return;
        const s = get();
        if (!s.activeSourceId || s.loading || s.refreshing || s.playback) return;
        if (!s.cacheAt) return;
        if (Date.now() - s.cacheAt > TWELVE_HOURS) {
          s.refreshContent().catch(() => {});
        }
      });
    }
  },

  async addSource(source) {
    const sources = [...get().sources, source];
    await saveSources(sources);
    set({ sources });
    await get().setActiveSource(source.id);
  },

  async updateSource(updated) {
    const sources = get().sources.map((s) => (s.id === updated.id ? updated : s));
    await saveSources(sources);
    set({ sources });
    // If the updated source is the active one, refresh its catalog & EPG —
    // the URLs may have changed.
    if (get().activeSourceId === updated.id) {
      // Bust the catalog cache so a fresh fetch happens (URL might have changed).
      await clearCache(updated.id).catch(() => {});
      // EPG cache is keyed off the EPG URL inside the payload, so it will
      // self-invalidate; no explicit clear needed.
      await get().loadContent({ force: true });
    }
  },

  async removeSource(id) {
    const sources = get().sources.filter((s) => s.id !== id);
    await saveSources(sources);
    await clearCache(id).catch(() => {});
    const activeSourceId = get().activeSourceId === id ? null : get().activeSourceId;
    if (activeSourceId !== get().activeSourceId) await saveActiveSourceId(activeSourceId);
    set({
      sources,
      activeSourceId,
      liveChannels: activeSourceId ? get().liveChannels : [],
      movies: activeSourceId ? get().movies : [],
      series: activeSourceId ? get().series : [],
      cacheAt: activeSourceId ? get().cacheAt : null,
    });
  },

  async setActiveSource(id) {
    await saveActiveSourceId(id);
    set({
      activeSourceId: id,
      selectedCategory: null,
      searchQuery: "",
      liveChannels: [],
      movies: [],
      series: [],
      cacheAt: null,
      epgIndex: {},
    });
    await get().loadContent();
  },

  async loadContent(opts = {}) {
    const { force = false } = opts;
    const { activeSourceId, sources } = get();
    const source = sources.find((s) => s.id === activeSourceId);
    if (!source) return;

    // 1. Try cache first (unless force)
    let usedCache = false;
    if (!force) {
      const cached = await loadCache(source.id);
      if (cached) {
        set({ ...applyCache(cached), loading: false, error: null });
        usedCache = true;
        if (isFresh(cached)) {
          // Fresh cache — done, no network fetch needed
          return;
        }
      }
    }

    // 2. Fetch fresh (in foreground if no cache shown; in background if cache shown)
    if (usedCache) {
      set({ refreshing: true });
    } else {
      set({ loading: true, error: null });
    }

    try {
      const fresh = await fetchFresh(source);
      const { detectedEpgUrl, ...catalog } = fresh;
      set({
        ...catalog,
        loading: false,
        refreshing: false,
        error: null,
        cacheAt: Date.now(),
      });
      await saveCache(source.id, catalog);

      // M3U source: persist auto-detected EPG URL onto the source so we
      // don't have to re-detect on every catalog refresh, but never
      // overwrite a manually-set epgUrl.
      if (source.type === "m3u" && detectedEpgUrl && !source.epgUrl) {
        const updatedSource = { ...source, epgUrl: detectedEpgUrl };
        const sources = get().sources.map((s) =>
          s.id === source.id ? updatedSource : s
        );
        await saveSources(sources);
        set({ sources });
      }

      // Load EPG (fire-and-forget, doesn't block UI). Refreshes from the
      // network if the cache is stale; otherwise just hydrates the in-memory
      // index so the player can show "now playing".
      void hydrateEpgFor(source.id).catch(() => {});
    } catch (e) {
      set({
        loading: false,
        refreshing: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },

  async refreshContent() {
    await get().loadContent({ force: true });
  },

  setView(v) {
    const prev = get().view;
    set({ view: v, previousView: prev, selectedCategory: null, searchQuery: "" });
  },

  goBack() {
    const { view } = get();
    if (view === "series-detail") set({ view: "series", selectedSeries: null });
    else if (view === "movie-detail") set({ view: "movies", selectedMovie: null });
    else if (
      view === "settings" ||
      view === "preferences" ||
      view === "live" ||
      view === "movies" ||
      view === "series"
    ) {
      set({ view: "home", selectedCategory: null, searchQuery: "" });
    }
  },

  async openMovieDetail(movie) {
    set({ selectedMovie: movie, view: "movie-detail" });

    if (movie.detailsLoaded) return;

    const { activeSourceId, sources } = get();
    const source = sources.find((s) => s.id === activeSourceId);
    if (!source) return;
    const xtream = effectiveXtreamSource(source);
    if (!xtream) {
      // M3U-only source — no extra info to fetch.
      return;
    }
    const vodId = extractXtreamVodId(movie);
    if (!vodId) return;

    try {
      const info = await loadXtreamMovieInfo(xtream, vodId);
      const enriched: Movie = {
        ...movie,
        backdrop: info.backdrop ?? movie.backdrop,
        plot: info.plot ?? movie.plot,
        cast: info.cast ?? movie.cast,
        director: info.director ?? movie.director,
        genre: info.genre ?? movie.genre,
        duration: info.duration ?? movie.duration,
        rating: info.rating ?? movie.rating,
        releaseDate: info.releaseDate ?? movie.releaseDate,
        logo: info.logo || movie.logo,
        detailsLoaded: true,
      };
      set((state) => ({
        selectedMovie: enriched,
        movies: state.movies.map((m) => (m.id === movie.id ? enriched : m)),
      }));
    } catch {
      // ignore — details are best-effort
    }
  },

  async openSeriesDetail(series) {
    set({ selectedSeries: series, view: "series-detail" });

    if (series.seasons && series.seasons.length > 0) return;
    if (!series.seriesId) return;

    const { activeSourceId, sources } = get();
    const source = sources.find((s) => s.id === activeSourceId);
    if (!source) return;
    // Works for direct Xtream sources AND for M3U URLs that are Xtream exports.
    const xtream = effectiveXtreamSource(source);
    if (!xtream) return;

    set({ loading: true, error: null });
    try {
      const seasons = await loadXtreamSeriesInfo(xtream, series.seriesId);
      const enriched = { ...series, seasons };
      set((state) => ({
        loading: false,
        selectedSeries: enriched,
        series: state.series.map((s) => (s.id === series.id ? enriched : s)),
      }));
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  setSelectedCategory(name) {
    set({ selectedCategory: name });
  },

  setSearchQuery(q) {
    set({ searchQuery: q });
  },

  setSortBy(sort) {
    set({ sortBy: sort });
  },

  async setAdultPin(pin) {
    const hash = pin ? await sha256Hex(pin) : null;
    const settings = { ...get().settings, adultPinHash: hash };
    await saveSettings(settings);
    set({ settings, adultUnlocked: !hash });
  },

  async unlockAdult(pin) {
    const { settings } = get();
    if (!settings.adultPinHash) {
      set({ adultUnlocked: true });
      return true;
    }
    const hash = await sha256Hex(pin);
    if (hash === settings.adultPinHash) {
      set({ adultUnlocked: true });
      return true;
    }
    return false;
  },

  lockAdult() {
    set({ adultUnlocked: false, selectedCategory: null });
  },

  async updateSettings(patch) {
    const next = { ...get().settings, ...patch };
    await saveSettings(next);
    set({ settings: next });
  },

  async markOnboarded() {
    await get().updateSettings({ hasOnboarded: true });
  },

  async toggleFavorite(id) {
    const set_ = new Set(get().favorites);
    if (set_.has(id)) set_.delete(id);
    else set_.add(id);
    const next = Array.from(set_);
    await saveFavorites(next);
    set({ favorites: next });
  },

  async saveProgress(entry) {
    const next = { ...get().watchProgress, [entry.itemId]: entry };
    // prune: keep only last 100 entries by updatedAt desc to avoid bloat
    const entries = Object.values(next).sort((a, b) => b.updatedAt - a.updatedAt);
    const pruned: Record<string, WatchProgress> = {};
    for (const e of entries.slice(0, 100)) pruned[e.itemId] = e;
    await saveWatchProgress(pruned);
    set({ watchProgress: pruned });
  },

  async clearProgress(id) {
    const next = { ...get().watchProgress };
    delete next[id];
    await saveWatchProgress(next);
    set({ watchProgress: next });
  },

  playLive(c, queue) {
    const nextQueue = queue && queue.length > 0 ? queue : [c];
    const idx = nextQueue.findIndex((q) => q.id === c.id);

    // Track this channel as recently-watched. Cap to the 100 most recent so
    // the registry doesn't grow forever.
    const updatedRecent = { ...get().liveRecent, [c.id]: Date.now() };
    const sorted = Object.entries(updatedRecent)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 100);
    const pruned: Record<string, number> = {};
    for (const [id, ts] of sorted) pruned[id] = ts;

    set({
      playback: {
        url: c.url,
        title: c.name,
        subtitle: c.category,
        kind: "live",
        itemId: c.id,
        logo: c.logo,
        contentType: "live",
      },
      liveQueue: nextQueue,
      liveQueueIndex: idx >= 0 ? idx : 0,
      currentEpg: [],
      liveRecent: pruned,
    });
    saveLiveRecent(pruned).catch(() => {});

    loadEpgForLive(c).then((epg) => {
      if (get().playback?.itemId === c.id) set({ currentEpg: epg, epgLoading: false });
    });
    if (isXtreamLive(c)) set({ epgLoading: true });
  },

  playMovie(m) {
    set({
      playback: {
        url: m.url,
        title: m.name,
        subtitle: m.year,
        kind: "vod",
        itemId: m.id,
        logo: m.logo,
        contentType: "movie",
      },
    });
  },

  playEpisode(ep, series) {
    const label = `T${ep.season}E${String(ep.episode).padStart(2, "0")}`;
    set({
      playback: {
        url: ep.url,
        title: series.name,
        subtitle: `${label} — ${ep.title ?? ep.name}`,
        kind: "vod",
        itemId: ep.id,
        parentId: series.id,
        logo: series.logo,
        contentType: "series",
      },
    });
  },

  stopPlayback() {
    set({ playback: null, liveQueue: [], liveQueueIndex: -1, currentEpg: [] });
  },

  nextLive() {
    const { liveQueue, liveQueueIndex } = get();
    if (liveQueue.length === 0 || liveQueueIndex < 0) return;
    const ni = (liveQueueIndex + 1) % liveQueue.length;
    get().playLive(liveQueue[ni], liveQueue);
  },

  prevLive() {
    const { liveQueue, liveQueueIndex } = get();
    if (liveQueue.length === 0 || liveQueueIndex < 0) return;
    const pi = (liveQueueIndex - 1 + liveQueue.length) % liveQueue.length;
    get().playLive(liveQueue[pi], liveQueue);
  },

  nextEpisode() {
    const s = get();
    const n = findEpisodeNeighbors(s.playback, s.series);
    if (!n || !n.next) return false;
    s.playEpisode(n.next, n.series);
    return true;
  },

  prevEpisode() {
    const s = get();
    const n = findEpisodeNeighbors(s.playback, s.series);
    if (!n || !n.prev) return false;
    s.playEpisode(n.prev, n.series);
    return true;
  },
}));

// -----------------------------------------------------------

function isXtreamLive(c: LiveChannel): boolean {
  return c.id.startsWith("xtream-live-");
}

function extractXtreamStreamId(c: LiveChannel): string | null {
  if (!isXtreamLive(c)) return null;
  const parts = c.id.split("-");
  const last = parts[parts.length - 1];
  return /^\d+$/.test(last) ? last : null;
}

function extractXtreamVodId(m: Movie): string | null {
  if (!m.id.startsWith("xtream-movie-")) return null;
  const parts = m.id.split("-");
  const last = parts[parts.length - 1];
  return /^\d+$/.test(last) ? last : null;
}

async function loadEpgForLive(c: LiveChannel): Promise<EpgProgram[]> {
  const state = useAppStore.getState();
  const source = state.sources.find((s) => s.id === state.activeSourceId);
  if (!source) return [];

  // Xtream sources: per-channel EPG via the `get_short_epg` API.
  const streamId = extractXtreamStreamId(c);
  if (streamId && source.type === "xtream") {
    return await loadXtreamShortEpg(source, streamId, 2);
  }

  // M3U sources: look up the channel in the in-memory XMLTV index by tvg-id.
  // The index is populated by `hydrateEpgFor` when the catalog loads.
  if (source.type === "m3u") {
    return programsAround(state.epgIndex, c.epgId, Date.now(), 1);
  }

  return [];
}

// Load (or refresh) the EPG/XMLTV index for the given source. Reads cached
// data first to populate the in-memory index immediately, then re-fetches
// from the network if the cache is stale or absent.
async function hydrateEpgFor(sourceId: string): Promise<void> {
  const state = useAppStore.getState();
  const source = state.sources.find((s) => s.id === sourceId);
  if (!source) return;

  // Only M3U sources need a precomputed index. Xtream uses its API per call.
  if (source.type !== "m3u") {
    if (Object.keys(state.epgIndex).length > 0) {
      useAppStore.setState({ epgIndex: {} });
    }
    return;
  }

  // 1. Hydrate from cache so the UI gets EPG immediately.
  const cached = await loadEpg(source.id);
  if (cached && cached.url === source.epgUrl) {
    useAppStore.setState({ epgIndex: cached.index });
    if (isEpgFresh(cached)) return; // still fresh, skip network
  }

  // 2. No EPG URL configured → nothing more we can do.
  if (!source.epgUrl) return;

  // 3. Fetch & parse XMLTV. This is the expensive step (5–50 MB download +
  // parse), but it runs in the background so the UI is never blocked.
  try {
    const xml = await fetchText(source.epgUrl);
    const index = parseXmltv(xml);
    useAppStore.setState({ epgIndex: index });
    await saveEpg(source.id, source.epgUrl, index);
  } catch (e) {
    console.warn("[epg] failed to fetch/parse XMLTV:", e);
  }
}
