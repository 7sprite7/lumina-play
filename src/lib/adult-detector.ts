const ADULT_KEYWORDS = [
  /\b18\s*\+/,
  /\+\s*18/,
  /\bxxx\b/i,
  /\badult/i,
  /\badulto/i,
  /\berotic/i,
  /\berótic/i,
  /\bporn/i,
  /\bhentai\b/i,
  /\bsex(o|y)?\b/i,
];

export function isAdultCategory(name: string, extraList: string[] = []): boolean {
  const lower = name.toLowerCase();
  if (extraList.some((c) => c.toLowerCase() === lower)) return true;
  return ADULT_KEYWORDS.some((re) => re.test(name));
}
