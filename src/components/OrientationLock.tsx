import { useEffect, useState } from "react";
import { useT } from "../lib/i18n";

// Touch device + portrait + narrow viewport. We deliberately gate on
// `pointer: coarse` so the overlay never shows on a desktop window that
// happens to be taller than wide — only on actual phones / small tablets
// held vertically.
const PORTRAIT_QUERY =
  "(pointer: coarse) and (orientation: portrait) and (max-width: 900px)";

function matches(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(PORTRAIT_QUERY).matches;
}

export default function OrientationLock() {
  const t = useT();
  const [show, setShow] = useState<boolean>(matches);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(PORTRAIT_QUERY);
    const handler = (e: MediaQueryListEvent) => setShow(e.matches);
    if (mq.addEventListener) mq.addEventListener("change", handler);
    else mq.addListener(handler);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", handler);
      else mq.removeListener(handler);
    };
  }, []);

  if (!show) return null;

  return (
    <div className="fixed inset-0 z-[100] bg-bg-900/95 backdrop-blur-md flex flex-col items-center justify-center p-6 text-center">
      <div className="mb-6 animate-spin-rotate">
        <svg
          className="w-24 h-24 text-accent"
          viewBox="0 0 64 64"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="22" y="8" width="20" height="36" rx="3" />
          <line x1="30" y1="40" x2="34" y2="40" />
          <path d="M14 32 Q14 50 32 50 L40 50" />
          <polyline points="36,46 40,50 36,54" />
        </svg>
      </div>

      <h2 className="text-xl font-semibold mb-2 text-slate-100">
        {t("orientation.title")}
      </h2>
      <p className="text-sm text-slate-300 max-w-xs leading-snug">
        {t("orientation.desc")}
      </p>

      <p className="mt-6 text-[11px] text-slate-500">
        {t("orientation.autoHide")}
      </p>
    </div>
  );
}
