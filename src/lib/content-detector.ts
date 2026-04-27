import type { ContentType } from "../types";

// Live-channel indicators take PRIORITY over movie/series keywords. A group
// like "Canais | Filmes e Séries" is a list of live channels, not movies —
// even though the word "Filmes" appears in it.
const LIVE_GROUP_RE =
  /\b(canais|canal|channels?|live\s*tv|tv\s*ao\s*vivo|iptv|streaming|emissoras?|rede\s*tv|networks?)\b/i;

const MOVIE_GROUP_RE = /\b(filme|filmes|movie|movies|vod|cinema|pel[íi]cula)\b/i;

const SERIES_GROUP_RE =
  /\b(s[ée]rie|s[ée]ries|temporada|temporadas|epis[óo]dio|season|episode|novelas?|anime|animes)\b/i;

export function detectContentType(url: string, groupTitle: string): ContentType {
  const u = url.toLowerCase();

  // Strongest signal: URL path
  if (u.includes("/movie/") || u.includes("/vod/")) return "movie";
  if (u.includes("/series/")) return "series";
  if (u.includes("/live/")) return "live";

  // Next strongest: group title starts with / contains LIVE keyword.
  // This prevents "Canais | Filmes e Séries" from being misclassified as movie.
  if (LIVE_GROUP_RE.test(groupTitle)) return "live";

  if (MOVIE_GROUP_RE.test(groupTitle)) return "movie";
  if (SERIES_GROUP_RE.test(groupTitle)) return "series";

  return "live";
}

const episodePatterns: RegExp[] = [
  /^(.+?)[\s._|-]+S(\d{1,2})[\s._-]*E(\d{1,3})\b/i,
  /^(.+?)[\s._|-]+T(\d{1,2})[\s._-]*E(\d{1,3})\b/i,
  /^(.+?)[\s._|-]+Season[\s._-]+(\d{1,2})[\s._-]+Episode[\s._-]+(\d{1,3})\b/i,
  /^(.+?)[\s._|-]+Temporada[\s._-]+(\d{1,2}).*?Epis[óo]dio[\s._-]+(\d{1,3})/i,
  /^(.+?)[\s._|-]+(\d{1,2})x(\d{1,3})\b/,
];

export interface EpisodeInfo {
  show: string;
  season: number;
  episode: number;
  title?: string;
}

export function parseEpisodeName(name: string): EpisodeInfo | null {
  for (const re of episodePatterns) {
    const m = name.match(re);
    if (m) {
      const show = m[1].replace(/[-–|·\s]+$/, "").trim();
      return {
        show,
        season: parseInt(m[2], 10),
        episode: parseInt(m[3], 10),
      };
    }
  }
  return null;
}
