// Smart, typo-tolerant search.
//
// We had Fuse.js here originally, but Fuse 7.x crashed with "Maximum call
// stack size exceeded" while indexing our larger lists (22k+ items), so we
// reimplemented the bits we actually need:
//
//   1. Exact-substring  — fastest path, ranks by match position.
//   2. All-tokens-AND   — every word in the query appears (any order).
//   3. Subsequence      — chars of the query appear in order with gaps,
//                          like fzf. Catches "incredbles" → "incredibles".
//   4. Bigram-Jaccard   — fallback scoring for harder typos. Pre-computed
//                          per item so per-keystroke cost stays low even
//                          on 22k items.
//
// All passes are iterative (no recursion → no stack overflow) and cap the
// fuzzy fallback to a budget so a single keystroke never blocks for long.

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  if (s.length < 2) {
    if (s.length === 1) out.add(s);
    return out;
  }
  for (let i = 0; i < s.length - 1; i++) out.add(s.substring(i, i + 2));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  // Iterate the smaller set for the intersection count.
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const x of small) if (big.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function isSubsequence(needle: string, haystack: string): boolean {
  // True when every char of `needle` appears in `haystack` in order
  // (allowing arbitrary gaps). Used as a typo-tolerant filter.
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i++;
  }
  return i === needle.length;
}

interface Searchable {
  name: string;
}

interface IndexEntry<T> {
  item: T;
  norm: string;
  bg: Set<string>;
}

export class SearchIndex<T extends Searchable> {
  private entries: IndexEntry<T>[];

  constructor(items: T[]) {
    // Pre-compute normalized name + bigrams once. Iterative — no recursion.
    this.entries = new Array(items.length);
    for (let i = 0; i < items.length; i++) {
      const norm = normalize(items[i].name);
      this.entries[i] = { item: items[i], norm, bg: bigrams(norm) };
    }
  }

  search(query: string): T[] {
    const q = normalize(query);
    if (!q) return this.entries.map((e) => e.item);

    const tokens = q.split(/\s+/).filter(Boolean);
    const qBg = bigrams(q);
    // Min Jaccard threshold for the fuzzy fallback. Looser when the user has
    // typed more chars (their intent is clearer), tighter for tiny queries.
    const fuzzyMin = q.length >= 6 ? 0.32 : q.length >= 4 ? 0.42 : 0.55;

    // Buckets keep their relative order; we concat at the end so exact matches
    // always rank above fuzzy ones regardless of jaccard score noise.
    const exact: { item: T; score: number }[] = [];
    const tokenAnd: { item: T; score: number }[] = [];
    const subseq: { item: T; score: number }[] = [];
    const fuzzy: { item: T; score: number }[] = [];

    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      const idx = e.norm.indexOf(q);
      if (idx >= 0) {
        // Earlier match → better score; ties broken by shorter name.
        exact.push({ item: e.item, score: idx * 1000 + e.norm.length });
        continue;
      }
      if (tokens.length > 1 && tokens.every((t) => e.norm.includes(t))) {
        tokenAnd.push({ item: e.item, score: e.norm.length });
        continue;
      }
      if (q.length >= 3 && isSubsequence(q, e.norm)) {
        // Subsequence: prefer items where the match is tighter (norm length
        // closer to query length means fewer gap chars).
        subseq.push({ item: e.item, score: e.norm.length - q.length });
        continue;
      }
      // Bigram fallback for harder typos / character swaps. Only run for
      // queries long enough to have a meaningful bigram set.
      if (q.length >= 4) {
        const j = jaccard(qBg, e.bg);
        if (j >= fuzzyMin) {
          fuzzy.push({ item: e.item, score: 1 - j });
        }
      }
    }

    exact.sort((a, b) => a.score - b.score);
    tokenAnd.sort((a, b) => a.score - b.score);
    subseq.sort((a, b) => a.score - b.score);
    fuzzy.sort((a, b) => a.score - b.score);

    return [
      ...exact.map((m) => m.item),
      ...tokenAnd.map((m) => m.item),
      ...subseq.map((m) => m.item),
      ...fuzzy.map((m) => m.item),
    ];
  }
}
