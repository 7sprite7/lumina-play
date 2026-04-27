import { invoke } from "@tauri-apps/api/core";

export async function isMpvInstalled(): Promise<boolean> {
  try {
    return await invoke<boolean>("is_mpv_installed");
  } catch {
    return false;
  }
}

export async function findMpv(): Promise<string | null> {
  try {
    const path = await invoke<string | null>("find_mpv");
    return path ?? null;
  } catch {
    return null;
  }
}

export async function openInMpv(url: string, title: string): Promise<void> {
  await invoke("open_in_mpv", { url, title });
}
