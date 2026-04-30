import { useEffect, useState } from "react";
import {
  APP_VERSION,
  fetchLatestRelease,
  isUpdateAvailable,
  type ReleaseInfo,
} from "../lib/update-checker";
import { IS_TAURI } from "../lib/platform";
import { useT } from "../lib/i18n";
import { IconClose, IconRefresh } from "./icons";

const DISMISSED_KEY = "lumina:update-dismissed-version";
const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

// Slim banner that appears at the top of the app when a newer release is
// published on GitHub (or wherever UPDATE_MANIFEST_URL points). Dismissing
// it stores the version in localStorage so the same release won't bother
// the user again — but the next release will.
export default function UpdateBanner() {
  const t = useT();
  const [release, setRelease] = useState<ReleaseInfo | null>(null);

  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      const latest = await fetchLatestRelease();
      if (cancelled || !latest) return;
      if (!isUpdateAvailable(latest.version)) return;
      // Honor the user's last "dismiss" — but only for the same version.
      // If a newer one is published, bother them again.
      try {
        const dismissed = window.localStorage.getItem(DISMISSED_KEY);
        if (dismissed === latest.version) return;
      } catch {
        // localStorage may be unavailable (private mode etc.) — fall through.
      }
      setRelease(latest);
    };

    // First check kicks off after a short delay so it doesn't compete with
    // the rest of the app's initial render / network calls.
    const initial = window.setTimeout(check, 5_000);
    const interval = window.setInterval(check, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, []);

  if (!release) return null;

  const handleOpen = async () => {
    if (IS_TAURI) {
      try {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(release.url);
        return;
      } catch {
        /* fall through to window.open */
      }
    }
    window.open(release.url, "_blank", "noopener,noreferrer");
  };

  const handleDismiss = () => {
    try {
      window.localStorage.setItem(DISMISSED_KEY, release.version);
    } catch {
      /* ignore */
    }
    setRelease(null);
  };

  return (
    <div className="bg-accent/90 text-white text-sm flex items-center gap-3 px-4 py-2 shrink-0 shadow-md backdrop-blur">
      <IconRefresh className="w-4 h-4 shrink-0" />
      <div className="flex-1 min-w-0 truncate">
        <span className="font-medium">
          {t("update.available", { version: release.version })}
        </span>
        <span className="opacity-75 ml-2 hidden sm:inline">
          {t("update.youHave", { version: APP_VERSION })}
        </span>
      </div>
      <button
        onClick={handleOpen}
        className="px-3 py-1 rounded-md bg-white/15 hover:bg-white/25 transition-colors font-medium whitespace-nowrap"
      >
        {t("update.viewRelease")}
      </button>
      <button
        onClick={handleDismiss}
        className="opacity-70 hover:opacity-100 transition-opacity"
        aria-label={t("update.dismiss")}
        title={t("update.dismiss")}
      >
        <IconClose className="w-4 h-4" />
      </button>
    </div>
  );
}
