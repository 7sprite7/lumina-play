import type { LiveChannel, Movie, SeriesItem } from "../types";
import { IS_TAURI } from "./platform";

// Catalog cache (live channels + movies + series). One blob per source id.
//
// Why two backends:
//
//   - **Tauri (desktop):** writes JSON files to `%APPDATA%\com.luminaplay.app\
//     cache\<sourceId>.json` via `@tauri-apps/plugin-fs`. Survives reinstall
//     of the app, no quota concerns even with 22k+ items.
//
//   - **Web:** uses IndexedDB. localStorage was tempting but capped around
//     5–10 MB depending on the browser, and a typical IPTV catalog blob is
//     several MB of JSON; IDB has no such practical limit. We keep the API
//     surface tiny — one tiny vanilla wrapper, no deps.
//
// The schema-version mechanism (CACHE_VERSION) is shared across backends so
// changing the item shape simultaneously invalidates both desktop files and
// web databases.

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

// ---------- Tauri (filesystem) backend ----------

async function tauriEnsureDir(): Promise<void> {
  try {
    const fs = await import("@tauri-apps/plugin-fs");
    const has = await fs.exists(CACHE_DIR, { baseDir: fs.BaseDirectory.AppData });
    if (!has) {
      await fs.mkdir(CACHE_DIR, { baseDir: fs.BaseDirectory.AppData, recursive: true });
    }
  } catch {
    // ignore
  }
}

async function tauriLoad(sourceId: string): Promise<ContentCache | null> {
  try {
    const fs = await import("@tauri-apps/plugin-fs");
    const file = fileFor(sourceId);
    const has = await fs.exists(file, { baseDir: fs.BaseDirectory.AppData });
    if (!has) return null;
    const text = await fs.readTextFile(file, { baseDir: fs.BaseDirectory.AppData });
    const parsed = JSON.parse(text) as ContentCache;
    if (!parsed || typeof parsed.timestamp !== "number") return null;
    if (parsed.version !== CACHE_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function tauriSave(sourceId: string, payload: ContentCache): Promise<void> {
  try {
    await tauriEnsureDir();
    const fs = await import("@tauri-apps/plugin-fs");
    await fs.writeTextFile(fileFor(sourceId), JSON.stringify(payload), {
      baseDir: fs.BaseDirectory.AppData,
    });
  } catch (e) {
    console.error("Failed to save cache (tauri)", e);
  }
}

async function tauriClear(sourceId: string): Promise<void> {
  try {
    const fs = await import("@tauri-apps/plugin-fs");
    const file = fileFor(sourceId);
    const has = await fs.exists(file, { baseDir: fs.BaseDirectory.AppData });
    if (has) await fs.remove(file, { baseDir: fs.BaseDirectory.AppData });
  } catch {
    // ignore
  }
}

// ---------- Web (IndexedDB) backend ----------

const DB_NAME = "lumina-play-cache";
const STORE_NAME = "catalog";
const DB_VERSION = 1;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbLoad(sourceId: string): Promise<ContentCache | null> {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(sanitize(sourceId));
      req.onsuccess = () => {
        const v = req.result as ContentCache | undefined;
        if (!v || typeof v.timestamp !== "number") return resolve(null);
        if (v.version !== CACHE_VERSION) return resolve(null);
        resolve(v);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function idbSave(sourceId: string, payload: ContentCache): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(payload, sanitize(sourceId));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error("Failed to save cache (idb)", e);
  }
}

async function idbClear(sourceId: string): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(sanitize(sourceId));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // ignore
  }
}

// ---------- Public API ----------

export async function loadCache(sourceId: string): Promise<ContentCache | null> {
  return IS_TAURI ? tauriLoad(sourceId) : idbLoad(sourceId);
}

export async function saveCache(
  sourceId: string,
  data: Omit<ContentCache, "timestamp" | "version">
): Promise<void> {
  const payload: ContentCache = { version: CACHE_VERSION, timestamp: Date.now(), ...data };
  return IS_TAURI ? tauriSave(sourceId, payload) : idbSave(sourceId, payload);
}

export async function clearCache(sourceId: string): Promise<void> {
  return IS_TAURI ? tauriClear(sourceId) : idbClear(sourceId);
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
