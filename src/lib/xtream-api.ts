import { IS_TAURI } from "./platform";
import { proxify } from "./proxy";
import type {
  LiveChannel,
  Movie,
  SeriesItem,
  XtreamSource,
  Season,
  Episode,
  EpgProgram,
} from "../types";

interface XtreamCategory {
  category_id: string;
  category_name: string;
}

interface XtreamLiveStream {
  stream_id: number;
  name: string;
  stream_icon?: string;
  category_id?: string;
  epg_channel_id?: string;
}

interface XtreamVodStream {
  stream_id: number;
  name: string;
  stream_icon?: string;
  category_id?: string;
  container_extension?: string;
  year?: string;
  rating?: string | number;
  plot?: string;
  added?: string;
}

interface XtreamSeriesStream {
  series_id: number;
  name: string;
  cover?: string;
  category_id?: string;
  year?: string;
  rating?: string | number;
  plot?: string;
  cast?: string;
  backdrop_path?: string[] | string;
  last_modified?: string;
}

interface XtreamSeriesInfoResponse {
  seasons?: Array<{ season_number: number; name: string }>;
  info?: {
    name?: string;
    cover?: string;
    plot?: string;
    cast?: string;
    backdrop_path?: string[] | string;
  };
  episodes?: Record<string, XtreamEpisode[]>;
}

interface XtreamEpisode {
  id: string;
  title: string;
  episode_num: number | string;
  season: number | string;
  container_extension: string;
  info?: { plot?: string; movie_image?: string };
}

function hostBase(src: XtreamSource) {
  return src.host.replace(/\/+$/, "");
}

function buildApiUrl(src: XtreamSource, action: string, params: Record<string, string> = {}) {
  const url = new URL(`${hostBase(src)}/player_api.php`);
  url.searchParams.set("username", src.username);
  url.searchParams.set("password", src.password);
  if (action) url.searchParams.set("action", action);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

async function getJSON<T>(url: string): Promise<T> {
  // Tauri: native HTTP via plugin (no CORS).
  // Web: browser fetch through the deployment's generic /proxy/ to bypass
  // CORS — the wrapping is a no-op when same-origin or running on HTTP.
  let res: Response;
  if (IS_TAURI) {
    const { fetch: tFetch } = await import("@tauri-apps/plugin-http");
    res = (await tFetch(url, { method: "GET" })) as unknown as Response;
  } else {
    res = await fetch(proxify(url), { method: "GET" });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

function toNumber(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : undefined;
}

// Sort streams so they're grouped by the order their categories appear in
// `get_*_categories`. The Xtream panel emits categories in display order
// (matching the M3U output), but `get_*_streams` returns items by stream_id
// or insertion order — when those orders differ the sidebar ends up with
// a different category sequence than the panel/M3U shows. Sorting here
// once means every downstream call (catalog cache, sidebar build, etc.)
// sees the right order without further special-casing.
//
// `Array.prototype.sort` is stable in modern JS, so streams within a single
// category keep their original API order.
function sortByCategoryOrder<T extends { category_id?: string }>(
  streams: T[],
  categories: { category_id: string }[]
): T[] {
  const order = new Map<string, number>();
  categories.forEach((c, i) => order.set(c.category_id, i));
  const fallback = categories.length;
  return [...streams].sort(
    (a, b) =>
      (order.get(a.category_id ?? "") ?? fallback) -
      (order.get(b.category_id ?? "") ?? fallback)
  );
}

export async function loadXtreamLive(src: XtreamSource): Promise<LiveChannel[]> {
  const [categories, streams] = await Promise.all([
    getJSON<XtreamCategory[]>(buildApiUrl(src, "get_live_categories")),
    getJSON<XtreamLiveStream[]>(buildApiUrl(src, "get_live_streams")),
  ]);
  const catMap = new Map(categories.map((c) => [c.category_id, c.category_name]));
  const host = hostBase(src);
  const sorted = sortByCategoryOrder(streams, categories);

  return sorted.map((s, i) => ({
    id: `xtream-live-${src.id}-${s.stream_id}`,
    contentType: "live" as const,
    name: s.name,
    logo: s.stream_icon,
    // Bare Xtream live format (host/user/pass/streamid). This is the format
    // every Xtream panel ever serves; the alternative `/live/.../.m3u8` HLS
    // endpoint is not universally supported. mpegts.js plays the raw MPEG-TS
    // stream that this URL returns, just like VLC does.
    url: `${host}/${src.username}/${src.password}/${s.stream_id}`,
    category: catMap.get(s.category_id || "") || "Sem categoria",
    epgId: s.epg_channel_id,
    order: i,
  }));
}

export async function loadXtreamMovies(src: XtreamSource): Promise<Movie[]> {
  const [categories, streams] = await Promise.all([
    getJSON<XtreamCategory[]>(buildApiUrl(src, "get_vod_categories")),
    getJSON<XtreamVodStream[]>(buildApiUrl(src, "get_vod_streams")),
  ]);
  const catMap = new Map(categories.map((c) => [c.category_id, c.category_name]));
  const host = hostBase(src);
  const sorted = sortByCategoryOrder(streams, categories);

  return sorted.map((s, i) => {
    const ext = s.container_extension || "mp4";
    return {
      id: `xtream-movie-${src.id}-${s.stream_id}`,
      contentType: "movie" as const,
      name: s.name,
      logo: s.stream_icon,
      url: `${host}/movie/${src.username}/${src.password}/${s.stream_id}.${ext}`,
      category: catMap.get(s.category_id || "") || "Sem categoria",
      year: s.year,
      rating: toNumber(s.rating),
      plot: s.plot,
      addedAt: toNumber(s.added),
      order: i,
    };
  });
}

export async function loadXtreamSeriesList(src: XtreamSource): Promise<SeriesItem[]> {
  const [categories, streams] = await Promise.all([
    getJSON<XtreamCategory[]>(buildApiUrl(src, "get_series_categories")),
    getJSON<XtreamSeriesStream[]>(buildApiUrl(src, "get_series")),
  ]);
  const catMap = new Map(categories.map((c) => [c.category_id, c.category_name]));
  const sorted = sortByCategoryOrder(streams, categories);

  return sorted.map((s, i) => {
    const backdrop = Array.isArray(s.backdrop_path) ? s.backdrop_path[0] : s.backdrop_path;
    return {
      id: `xtream-series-${src.id}-${s.series_id}`,
      contentType: "series" as const,
      name: s.name,
      logo: s.cover,
      backdrop,
      category: catMap.get(s.category_id || "") || "Sem categoria",
      year: s.year,
      rating: toNumber(s.rating),
      plot: s.plot,
      cast: s.cast,
      seriesId: String(s.series_id),
      addedAt: toNumber(s.last_modified),
      order: i,
    };
  });
}

function base64Decode(s: string): string {
  if (!s) return "";
  try {
    // atob → binary string; wrap in decodeURIComponent(escape()) to handle UTF-8
    return decodeURIComponent(escape(atob(s)));
  } catch {
    return s;
  }
}

interface XtreamShortEpgEntry {
  id?: string;
  title?: string;
  description?: string;
  start?: string;
  end?: string;
  start_timestamp?: string | number;
  stop_timestamp?: string | number;
  now_playing?: number;
}

interface XtreamVodInfoResponse {
  info?: {
    cover_big?: string;
    movie_image?: string;
    backdrop_path?: string[] | string;
    plot?: string;
    description?: string;
    cast?: string;
    actors?: string;
    director?: string;
    genre?: string;
    duration?: string;
    duration_secs?: number | string;
    rating?: string | number;
    releasedate?: string;
    releaseDate?: string;
  };
}

function formatDurationSecs(secs: number): string {
  if (!Number.isFinite(secs) || secs <= 0) return "";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}min`;
  return `${m}min`;
}

export interface XtreamMovieInfo {
  backdrop?: string;
  plot?: string;
  cast?: string;
  director?: string;
  genre?: string;
  duration?: string;
  rating?: number;
  releaseDate?: string;
  logo?: string;
}

export async function loadXtreamMovieInfo(
  src: XtreamSource,
  vodId: string
): Promise<XtreamMovieInfo> {
  try {
    const url = buildApiUrl(src, "get_vod_info", { vod_id: vodId });
    const data = await getJSON<XtreamVodInfoResponse>(url);
    const info = data.info ?? {};
    const backdrop = Array.isArray(info.backdrop_path)
      ? info.backdrop_path[0]
      : info.backdrop_path;
    const durationSecs = toNumber(info.duration_secs);
    return {
      backdrop: backdrop || undefined,
      plot: info.plot || info.description || undefined,
      cast: info.cast || info.actors || undefined,
      director: info.director || undefined,
      genre: info.genre || undefined,
      duration:
        info.duration ||
        (durationSecs ? formatDurationSecs(durationSecs) : undefined),
      rating: toNumber(info.rating),
      releaseDate: info.releasedate || info.releaseDate || undefined,
      logo: info.cover_big || info.movie_image || undefined,
    };
  } catch {
    return {};
  }
}

export async function loadXtreamShortEpg(
  src: XtreamSource,
  streamId: string,
  limit = 2
): Promise<EpgProgram[]> {
  try {
    const url = buildApiUrl(src, "get_short_epg", {
      stream_id: streamId,
      limit: String(limit),
    });
    const data = await getJSON<{ epg_listings?: XtreamShortEpgEntry[] }>(url);
    const list = data.epg_listings ?? [];
    return list.map((e) => ({
      title: base64Decode(e.title ?? ""),
      description: base64Decode(e.description ?? ""),
      start: (toNumber(e.start_timestamp) ?? 0) * 1000,
      stop: (toNumber(e.stop_timestamp) ?? 0) * 1000,
      nowPlaying: e.now_playing === 1,
    }));
  } catch {
    return [];
  }
}

export async function loadXtreamSeriesInfo(
  src: XtreamSource,
  seriesId: string
): Promise<Season[]> {
  const data = await getJSON<XtreamSeriesInfoResponse>(
    buildApiUrl(src, "get_series_info", { series_id: seriesId })
  );
  const host = hostBase(src);
  const seasons: Season[] = [];

  const episodesMap = data.episodes ?? {};
  for (const [seasonKey, eps] of Object.entries(episodesMap)) {
    const seasonNum = parseInt(seasonKey, 10) || 0;
    const episodes: Episode[] = eps.map((e) => ({
      id: `xtream-ep-${e.id}`,
      name: e.title,
      title: e.title,
      season: typeof e.season === "number" ? e.season : parseInt(String(e.season), 10) || seasonNum,
      episode:
        typeof e.episode_num === "number"
          ? e.episode_num
          : parseInt(String(e.episode_num), 10) || 0,
      url: `${host}/series/${src.username}/${src.password}/${e.id}.${e.container_extension}`,
      plot: e.info?.plot,
      image: e.info?.movie_image,
    }));
    episodes.sort((a, b) => a.episode - b.episode);
    seasons.push({ number: seasonNum, episodes });
  }

  seasons.sort((a, b) => a.number - b.number);
  return seasons;
}
