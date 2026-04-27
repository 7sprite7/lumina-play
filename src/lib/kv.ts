// Tiny key-value store abstraction. Concrete implementations:
//
//   - TauriKVStore   — thin wrapper around `LazyStore` (writes JSON to
//                      `%APPDATA%\com.luminaplay.app\iptv-player.json`).
//                      Used in the Tauri desktop build.
//
//   - LocalStorageKV — synchronous browser localStorage, wrapped in
//                      Promises to match the async surface of LazyStore.
//                      Used in the web build.
//
// Both implementations expose the exact same surface so the rest of the
// codebase doesn't have to know which backend it's talking to.

import { IS_TAURI } from "./platform";

export interface KVStore {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

class LocalStorageKV implements KVStore {
  // Single localStorage prefix; each key becomes `lumina:<key>`.
  constructor(private prefix: string) {}

  private k(key: string): string {
    return `${this.prefix}:${key}`;
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = window.localStorage.getItem(this.k(key));
      if (raw === null) return null;
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    try {
      window.localStorage.setItem(this.k(key), JSON.stringify(value));
    } catch (e) {
      // localStorage can throw if the user is over quota or in private mode.
      console.warn("[kv] localStorage set failed", e);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      window.localStorage.removeItem(this.k(key));
    } catch {
      // ignore
    }
  }
}

class TauriKVStore implements KVStore {
  // The actual LazyStore is loaded lazily so the web bundle doesn't import
  // `@tauri-apps/plugin-store` at all.
  private storePromise: Promise<{
    get<T>(k: string): Promise<T | undefined>;
    set(k: string, v: unknown): Promise<void>;
    delete(k: string): Promise<void>;
    save(): Promise<void>;
  }> | null = null;

  constructor(private filename: string) {}

  private async store() {
    if (!this.storePromise) {
      this.storePromise = import("@tauri-apps/plugin-store").then(
        (m) => new m.LazyStore(this.filename) as never
      );
    }
    return this.storePromise;
  }

  async get<T>(key: string): Promise<T | null> {
    const s = await this.store();
    return ((await s.get<T>(key)) as T) ?? null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    const s = await this.store();
    await s.set(key, value as unknown);
    await s.save();
  }

  async delete(key: string): Promise<void> {
    const s = await this.store();
    await s.delete(key);
    await s.save();
  }
}

export function createKV(filename: string, webPrefix: string): KVStore {
  return IS_TAURI ? new TauriKVStore(filename) : new LocalStorageKV(webPrefix);
}
