export type SourceType = "m3u" | "xtream";

export interface M3USource {
  id: string;
  type: "m3u";
  name: string;
  url: string;
}

export interface XtreamSource {
  id: string;
  type: "xtream";
  name: string;
  host: string;
  username: string;
  password: string;
}

export type Source = M3USource | XtreamSource;

export type ContentType = "live" | "movie" | "series";

export interface LiveChannel {
  id: string;
  contentType: "live";
  name: string;
  logo?: string;
  url: string;
  category: string;
  epgId?: string;
  order?: number;
}

export type SortBy = "default" | "az" | "za" | "recent";

export type Language = "pt" | "en";
export type Theme = "classic" | "modern";
export type DateFormat = "ddmmyyyy" | "mmddyyyy" | "iso";
export type TimeFormat = "24h" | "12h";

export interface AppSettings {
  adultPinHash: string | null;
  adultCategoriesExtra: string[];
  language: Language;
  theme: Theme;
  dateFormat: DateFormat;
  timeFormat: TimeFormat;
  showEpg: boolean;
  hasOnboarded: boolean;
}

export interface Movie {
  id: string;
  contentType: "movie";
  name: string;
  logo?: string;
  url: string;
  category: string;
  year?: string;
  rating?: number;
  plot?: string;
  addedAt?: number;
  order?: number;
  // Enriched (lazy from Xtream get_vod_info)
  backdrop?: string;
  cast?: string;
  director?: string;
  genre?: string;
  duration?: string;
  releaseDate?: string;
  detailsLoaded?: boolean;
}

export interface Episode {
  id: string;
  name: string;
  title?: string;
  season: number;
  episode: number;
  url: string;
  plot?: string;
  image?: string;
}

export interface Season {
  number: number;
  episodes: Episode[];
}

export interface SeriesItem {
  id: string;
  contentType: "series";
  name: string;
  logo?: string;
  backdrop?: string;
  category: string;
  year?: string;
  rating?: number;
  plot?: string;
  cast?: string;
  seriesId?: string;
  seasons?: Season[];
  addedAt?: number;
  order?: number;
}

export type MediaItem = LiveChannel | Movie | SeriesItem;

export interface Category {
  name: string;
  count: number;
}

export type View =
  | "home"
  | "live"
  | "movies"
  | "series"
  | "series-detail"
  | "movie-detail"
  | "settings"
  | "preferences";

export interface PlaybackItem {
  url: string;
  title: string;
  subtitle?: string;
  kind: "live" | "vod";
  itemId?: string;
  parentId?: string;
  logo?: string;
  contentType?: ContentType;
}

export interface EpgProgram {
  title: string;
  description?: string;
  start: number;
  stop: number;
  nowPlaying?: boolean;
}

export interface WatchProgress {
  itemId: string;
  parentId?: string;
  position: number;
  duration: number;
  updatedAt: number;
  title: string;
  subtitle?: string;
  logo?: string;
  category?: string;
  contentType: "movie" | "series";
}
