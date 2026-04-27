import type { Category } from "../types";

export const V_CAT = {
  CONTINUE: "__continue__",
  FAVORITES: "__favorites__",
  RECENT: "__recent__",
} as const;

export type VirtualCategory = typeof V_CAT[keyof typeof V_CAT];

export function isVirtualCategory(name: string | null): name is VirtualCategory {
  if (!name) return false;
  return name === V_CAT.CONTINUE || name === V_CAT.FAVORITES || name === V_CAT.RECENT;
}

// Category ordering for the sidebar:
// 1. Cinema (pinned first)
// 2. Lançamentos YYYY (newest year first)
// 3. Everything else by item count (desc), then name asc
export function sortCategoriesForSidebar(cats: Category[]): Category[] {
  const cinema: Category[] = [];
  const lancamentos: Category[] = [];
  const rest: Category[] = [];

  for (const c of cats) {
    const lower = c.name.toLowerCase();
    if (/\bcinema\b/i.test(c.name)) {
      cinema.push(c);
    } else if (/lan[çc]amentos?\s*\d{2,4}/.test(lower)) {
      lancamentos.push(c);
    } else {
      rest.push(c);
    }
  }

  const yearOf = (s: string): number => {
    const m = s.match(/(\d{2,4})/);
    if (!m) return 0;
    let n = parseInt(m[1], 10);
    if (n < 100) n += 2000; // "24" → 2024
    return n;
  };

  lancamentos.sort((a, b) => yearOf(b.name) - yearOf(a.name));
  cinema.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  rest.sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name, "pt-BR")
  );

  return [...cinema, ...lancamentos, ...rest];
}

export function isRecentlyAdded(addedAt: number | undefined, nowMs = Date.now()): boolean {
  if (!addedAt) return false;
  const tsMs = addedAt > 1e12 ? addedAt : addedAt * 1000; // support sec or ms
  const thirtyDays = 30 * 24 * 3600 * 1000;
  return nowMs - tsMs < thirtyDays;
}

export function isInProgress(progress: {
  position: number;
  duration: number;
}): boolean {
  if (!progress.duration || progress.duration < 30) return false;
  if (progress.position < 5) return false;
  const pct = progress.position / progress.duration;
  return pct < 0.95;
}
