import type { AppSettings, Source, WatchProgress } from "../types";
import { createKV } from "./kv";

// Single store for all the small typed-config blobs (sources list, active
// source id, settings, favourites, watch progress, live recently-watched).
// Backed by `iptv-player.json` on Tauri and by `lumina-play:*` keys in
// localStorage on the web build.
const store = createKV("iptv-player.json", "lumina-play");

const SOURCES_KEY = "sources";
const ACTIVE_SOURCE_KEY = "active_source_id";
const SETTINGS_KEY = "settings";
const FAVORITES_KEY = "favorites";
const WATCH_PROGRESS_KEY = "watch_progress";
const LIVE_RECENT_KEY = "live_recent";

const DEFAULT_SETTINGS: AppSettings = {
  adultPinHash: null,
  adultCategoriesExtra: [],
  language: "pt",
  theme: "classic",
  dateFormat: "ddmmyyyy",
  timeFormat: "24h",
  showEpg: false,
  hasOnboarded: false,
};

export async function loadSources(): Promise<Source[]> {
  return (await store.get<Source[]>(SOURCES_KEY)) ?? [];
}

export async function saveSources(sources: Source[]): Promise<void> {
  await store.set(SOURCES_KEY, sources);
}

export async function loadActiveSourceId(): Promise<string | null> {
  return (await store.get<string>(ACTIVE_SOURCE_KEY)) ?? null;
}

export async function saveActiveSourceId(id: string | null): Promise<void> {
  if (id === null) await store.delete(ACTIVE_SOURCE_KEY);
  else await store.set(ACTIVE_SOURCE_KEY, id);
}

export async function loadSettings(): Promise<AppSettings> {
  const saved = await store.get<AppSettings>(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await store.set(SETTINGS_KEY, settings);
}

export async function loadFavorites(): Promise<string[]> {
  return (await store.get<string[]>(FAVORITES_KEY)) ?? [];
}

export async function saveFavorites(ids: string[]): Promise<void> {
  await store.set(FAVORITES_KEY, ids);
}

export async function loadWatchProgress(): Promise<Record<string, WatchProgress>> {
  return (await store.get<Record<string, WatchProgress>>(WATCH_PROGRESS_KEY)) ?? {};
}

export async function saveWatchProgress(data: Record<string, WatchProgress>): Promise<void> {
  await store.set(WATCH_PROGRESS_KEY, data);
}

// Live channel "recently watched" registry: channel.id → last play timestamp.
// Live streams have no progress to resume, so we just track when we last
// tuned in and surface the most recent ones in a virtual category.
export async function loadLiveRecent(): Promise<Record<string, number>> {
  return (await store.get<Record<string, number>>(LIVE_RECENT_KEY)) ?? {};
}

export async function saveLiveRecent(data: Record<string, number>): Promise<void> {
  await store.set(LIVE_RECENT_KEY, data);
}
