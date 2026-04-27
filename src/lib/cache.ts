import {
  BaseDirectory,
  exists,
  mkdir,
  readTextFile,
  writeTextFile,
  remove,
} from "@tauri-apps/plugin-fs";
import type { LiveChannel, Movie, SeriesItem } from "../types";

export interface ContentCache {
  version: number;
  timestamp: number;
  liveChannels: LiveChannel[];
  movies: Movie[];
  series: SeriesItem[];
}

const CACHE_DIR = "cache";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const CACHE_VERSION = 8; // bump when item schema changes

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function fileFor(sourceId: string): string {
  return `${CACHE_DIR}/${sanitize(sourceId)}.json`;
}

async function ensureDir(): Promise<void> {
  try {
    const has = await exists(CACHE_DIR, { baseDir: BaseDirectory.AppData });
    if (!has) {
      await mkdir(CACHE_DIR, { baseDir: BaseDirectory.AppData, recursive: true });
    }
  } catch {
    // ignore
  }
}

export async function loadCache(sourceId: string): Promise<ContentCache | null> {
  try {
    const file = fileFor(sourceId);
    const has = await exists(file, { baseDir: BaseDirectory.AppData });
    if (!has) return null;
    const text = await readTextFile(file, { baseDir: BaseDirectory.AppData });
    const parsed = JSON.parse(text) as ContentCache;
    if (!parsed || typeof parsed.timestamp !== "number") return null;
    if (parsed.version !== CACHE_VERSION) return null; // schema changed, invalidate
    return parsed;
  } catch {
    return null;
  }
}

export async function saveCache(
  sourceId: string,
  data: Omit<ContentCache, "timestamp" | "version">
): Promise<void> {
  try {
    await ensureDir();
    const payload: ContentCache = { version: CACHE_VERSION, timestamp: Date.now(), ...data };
    await writeTextFile(fileFor(sourceId), JSON.stringify(payload), {
      baseDir: BaseDirectory.AppData,
    });
  } catch (e) {
    console.error("Failed to save cache", e);
  }
}

export async function clearCache(sourceId: string): Promise<void> {
  try {
    const file = fileFor(sourceId);
    const has = await exists(file, { baseDir: BaseDirectory.AppData });
    if (has) await remove(file, { baseDir: BaseDirectory.AppData });
  } catch {
    // ignore
  }
}

export function isFresh(cache: ContentCache): boolean {
  return Date.now() - cache.timestamp < CACHE_TTL_MS;
}

export function cacheAge(cache: ContentCache): { ms: number; label: string } {
  const ms = Date.now() - cache.timestamp;
  const min = Math.round(ms / 60000);
  if (min < 1) return { ms, label: "agora" };
  if (min < 60) return { ms, label: `${min} min` };
  const h = Math.floor(min / 60);
  return { ms, label: `${h}h atrás` };
}
