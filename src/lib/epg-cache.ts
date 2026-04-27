import { IS_TAURI } from "./platform";
import type { EpgIndex } from "./xmltv-parser";

// Per-source EPG cache (parsed XMLTV index). Mirrors `cache.ts` but stored
// in a separate file/IDB store so the main catalog cache and the EPG can
// expire independently — XMLTV is updated on a different schedule than the
// catalog by most providers.
//
// The cached payload is the **already-parsed** index (channelId → programmes),
// not the raw XML. Storing the parsed form means startup doesn't have to
// re-parse a 5–50 MB file every time.

export interface EpgCachePayload {
  version: number;
  fetchedAt: number;
  // Hash of the XMLTV URL the cache was built from — invalidated if the
  // user changes the EPG URL on the source.
  url: string;
  index: EpgIndex;
}

const EPG_VERSION = 1;
const EPG_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const EPG_DIR = "epg";

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function fileFor(sourceId: string): string {
  return `${EPG_DIR}/${sanitize(sourceId)}.json`;
}

export function isEpgFresh(c: EpgCachePayload): boolean {
  return Date.now() - c.fetchedAt < EPG_TTL_MS;
}

// ---------- Tauri (filesystem) backend ----------

async function tauriEnsureDir(): Promise<void> {
  try {
    const fs = await import("@tauri-apps/plugin-fs");
    const has = await fs.exists(EPG_DIR, { baseDir: fs.BaseDirectory.AppData });
    if (!has) {
      await fs.mkdir(EPG_DIR, { baseDir: fs.BaseDirectory.AppData, recursive: true });
    }
  } catch {
    // ignore
  }
}

async function tauriLoad(sourceId: string): Promise<EpgCachePayload | null> {
  try {
    const fs = await import("@tauri-apps/plugin-fs");
    const file = fileFor(sourceId);
    const has = await fs.exists(file, { baseDir: fs.BaseDirectory.AppData });
    if (!has) return null;
    const text = await fs.readTextFile(file, { baseDir: fs.BaseDirectory.AppData });
    const parsed = JSON.parse(text) as EpgCachePayload;
    if (!parsed || typeof parsed.fetchedAt !== "number") return null;
    if (parsed.version !== EPG_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function tauriSave(sourceId: string, payload: EpgCachePayload): Promise<void> {
  try {
    await tauriEnsureDir();
    const fs = await import("@tauri-apps/plugin-fs");
    await fs.writeTextFile(fileFor(sourceId), JSON.stringify(payload), {
      baseDir: fs.BaseDirectory.AppData,
    });
  } catch (e) {
    console.error("Failed to save epg cache (tauri)", e);
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

const DB_NAME = "lumina-play-epg";
const STORE_NAME = "epg";
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

async function idbLoad(sourceId: string): Promise<EpgCachePayload | null> {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(sanitize(sourceId));
      req.onsuccess = () => {
        const v = req.result as EpgCachePayload | undefined;
        if (!v || typeof v.fetchedAt !== "number") return resolve(null);
        if (v.version !== EPG_VERSION) return resolve(null);
        resolve(v);
      };
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function idbSave(sourceId: string, payload: EpgCachePayload): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(payload, sanitize(sourceId));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error("Failed to save epg cache (idb)", e);
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

export async function loadEpg(sourceId: string): Promise<EpgCachePayload | null> {
  return IS_TAURI ? tauriLoad(sourceId) : idbLoad(sourceId);
}

export async function saveEpg(
  sourceId: string,
  url: string,
  index: EpgIndex
): Promise<void> {
  const payload: EpgCachePayload = {
    version: EPG_VERSION,
    fetchedAt: Date.now(),
    url,
    index,
  };
  return IS_TAURI ? tauriSave(sourceId, payload) : idbSave(sourceId, payload);
}

export async function clearEpg(sourceId: string): Promise<void> {
  return IS_TAURI ? tauriClear(sourceId) : idbClear(sourceId);
}
