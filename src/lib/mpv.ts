import { IS_TAURI } from "./platform";

// All mpv calls go through Tauri commands. On the web build there's no
// native mpv, so the helpers short-circuit to "not installed" / no-op
// responses. The Player UI already hides the mpv button when `IS_TAURI` is
// false, so these are mostly defensive.

export async function isMpvInstalled(): Promise<boolean> {
  if (!IS_TAURI) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<boolean>("is_mpv_installed");
  } catch {
    return false;
  }
}

export async function findMpv(): Promise<string | null> {
  if (!IS_TAURI) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const path = await invoke<string | null>("find_mpv");
    return path ?? null;
  } catch {
    return null;
  }
}

export async function openInMpv(url: string, title: string): Promise<void> {
  if (!IS_TAURI) {
    throw new Error("mpv not available on web");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("open_in_mpv", { url, title });
}
