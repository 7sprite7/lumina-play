import type { ContentType } from "../types";

const TYPE_PREFIX_RE: Record<ContentType, RegExp[]> = {
  movie: [
    /^\s*filmes?\s*[|:\-–•>»]+\s*/i,
    /^\s*movies?\s*[|:\-–•>»]+\s*/i,
    /^\s*vod\s*[|:\-–•>»]+\s*/i,
    /^\s*cinema\s*[|:\-–•>»]+\s*/i,
  ],
  series: [
    /^\s*s[ée]ries?\s*[|:\-–•>»]+\s*/i,
    /^\s*series?\s*[|:\-–•>»]+\s*/i,
    /^\s*tv\s*shows?\s*[|:\-–•>»]+\s*/i,
    /^\s*novelas?\s*[|:\-–•>»]+\s*/i,
  ],
  live: [
    /^\s*canais?\s*[|:\-–•>»]+\s*/i,
    /^\s*channels?\s*[|:\-–•>»]+\s*/i,
    /^\s*live\s*tv\s*[|:\-–•>»]+\s*/i,
    /^\s*tv\s*[|:\-–•>»]+\s*/i,
  ],
};

// Returns a cleaned, display-friendly version of a category name by removing
// common content-type prefixes (e.g. "Filmes | Drama" -> "Drama" within Movies).
export function cleanCategoryName(name: string, type: ContentType): string {
  let out = name;
  for (const re of TYPE_PREFIX_RE[type]) {
    const cleaned = out.replace(re, "");
    if (cleaned !== out && cleaned.trim().length > 0) {
      out = cleaned;
    }
  }
  return out.trim() || name;
}
