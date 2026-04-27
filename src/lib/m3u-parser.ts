import type { LiveChannel, Movie, SeriesItem, Episode } from "../types";
import { detectContentType, parseEpisodeName } from "./content-detector";

export interface ParsedM3U {
  live: LiveChannel[];
  movies: Movie[];
  series: SeriesItem[];
  // XMLTV/EPG URL extracted from the `#EXTM3U url-tvg="..."` header line
  // (some providers also use `x-tvg-url=` or `tvg-url=`).
  epgUrl?: string;
}

const attrRegex = /([a-zA-Z0-9-]+)="([^"]*)"/g;

function parseAttrs(line: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let match: RegExpExecArray | null;
  attrRegex.lastIndex = 0;
  while ((match = attrRegex.exec(line)) !== null) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

// Find the comma that separates EXTINF attributes from the display name,
// ignoring commas inside double-quoted attribute values.
function findExtinfSeparator(line: string): number {
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === "," && !inQuotes) return i;
  }
  return -1;
}

interface RawEntry {
  name: string;
  url: string;
  logo?: string;
  category: string;
  epgId?: string;
}

function parseEntries(content: string): RawEntry[] {
  const lines = content.split(/\r?\n/);
  const entries: RawEntry[] = [];
  let current: Partial<RawEntry> | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith("#EXTINF")) {
      const sepIdx = findExtinfSeparator(line);
      const header = sepIdx >= 0 ? line.slice(0, sepIdx) : line;
      let name = sepIdx >= 0 ? line.slice(sepIdx + 1).trim() : "";
      const attrs = parseAttrs(header);
      name = name.replace(/\s*(tvg-[a-z0-9-]+|group-title|tvg-logo)="[^"]*".*$/i, "").trim();
      if (!name) name = attrs["tvg-name"] || "Desconhecido";
      current = {
        name,
        logo: attrs["tvg-logo"] || undefined,
        category: (attrs["group-title"] || "Sem categoria").trim() || "Sem categoria",
        epgId: attrs["tvg-id"] || undefined,
      };
    } else if (!line.startsWith("#") && current) {
      current.url = line;
      entries.push(current as RawEntry);
      current = null;
    }
  }

  return entries;
}

// Score a logo URL by how poster-like it looks. Higher = better series cover.
// - Heavy negative for URLs that clearly reference an individual episode (S01E01, cap1,
//   episode, temporada, ss1_ep01...).
// - Positive for URLs that reference a poster / cover / capa.
// - Shorter paths tend to be posters rather than per-episode screenshots.
function scoreLogoUrl(url: string): number {
  const lower = url.toLowerCase();
  let score = 0;

  // Episode patterns (big penalty)
  if (/\b[sS]\d{1,2}[_.\s-]?[eE]\d{1,3}\b/.test(url)) score -= 20;
  if (/\b\d{1,2}x\d{1,3}\b/.test(url)) score -= 15;
  if (/\bepisode[-_\s]?\d+/i.test(lower)) score -= 15;
  if (/\btemporada[-_\s]?\d+/i.test(lower)) score -= 15;
  if (/\bcap[ií]?tulo[-_\s]?\d+|\bcap[-_\s]?\d+/i.test(lower)) score -= 12;
  if (/[-_/]ep\d+/i.test(lower)) score -= 10;
  if (/[-_/]t\d+e\d+/i.test(lower)) score -= 15;

  // Series-level indicators (boost)
  if (/\bposter\b|\bcover\b|\bcapa\b/i.test(lower)) score += 12;
  if (/\/series?[\-_\/]|\/shows?\//i.test(lower)) score += 3;
  if (/\blogo\b/i.test(lower)) score += 4;

  // Shorter URL heuristic (posters tend to have cleaner paths)
  const pathLen = lower.replace(/^https?:\/\/[^/]+/, "").length;
  if (pathLen < 60) score += 2;
  if (pathLen > 150) score -= 2;

  return score;
}

// Pick the "best" series logo from episode tvg-logos:
// 1. If a URL is shared across episodes → it is almost certainly the series poster
//    (score it with a large boost for count >= 2).
// 2. Otherwise (all episodes have distinct logos = provider put screenshots per ep)
//    pick the one that looks most poster-like by URL heuristic.
function pickSeriesLogo(logos: string[]): string | undefined {
  if (logos.length === 0) return undefined;

  const counts = new Map<string, number>();
  for (const l of logos) counts.set(l, (counts.get(l) ?? 0) + 1);

  let best: string | undefined;
  let bestScore = -Infinity;
  for (const [url, count] of counts.entries()) {
    let score = scoreLogoUrl(url);
    // Shared across several episodes → strong signal of being the poster.
    if (count > 1) score += 25 + count; // +25 for being shared at all, +1 per extra occurrence
    if (score > bestScore) {
      bestScore = score;
      best = url;
    }
  }
  return best;
}

interface SeriesBuilder {
  item: SeriesItem;
  logos: string[];
}

// Pull the EPG/XMLTV URL out of the playlist header line. Different providers
// use different attribute names — we try the common ones in order.
function extractEpgUrlFromHeader(content: string): string | undefined {
  const firstLine = content.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!firstLine.startsWith("#EXTM3U")) return undefined;
  const attrs = parseAttrs(firstLine);
  return (
    attrs["url-tvg"] ||
    attrs["x-tvg-url"] ||
    attrs["tvg-url"] ||
    undefined
  );
}

export function parseM3U(content: string): ParsedM3U {
  const epgUrl = extractEpgUrlFromHeader(content);
  const entries = parseEntries(content);
  const live: LiveChannel[] = [];
  const movies: Movie[] = [];
  const seriesMap = new Map<string, SeriesBuilder>();
  let id = 0;
  const nextId = () => `m3u-${id++}`;

  for (const e of entries) {
    const ct = detectContentType(e.url, e.category);
    const order = id;

    if (ct === "live") {
      live.push({
        id: nextId(),
        contentType: "live",
        name: e.name,
        logo: e.logo,
        url: e.url,
        category: e.category,
        epgId: e.epgId,
        order,
      });
      continue;
    }

    if (ct === "movie") {
      movies.push({
        id: nextId(),
        contentType: "movie",
        name: e.name,
        logo: e.logo,
        url: e.url,
        category: e.category,
        order,
      });
      continue;
    }

    // series
    const info = parseEpisodeName(e.name);
    if (!info) {
      live.push({
        id: nextId(),
        contentType: "live",
        name: e.name,
        logo: e.logo,
        url: e.url,
        category: e.category,
        epgId: e.epgId,
        order,
      });
      continue;
    }

    const key = `${info.show.toLowerCase()}|${e.category}`;
    let builder = seriesMap.get(key);
    if (!builder) {
      builder = {
        item: {
          id: `series-${id++}`,
          contentType: "series",
          name: info.show,
          category: e.category,
          seasons: [],
          order,
        },
        logos: [],
      };
      seriesMap.set(key, builder);
    }

    if (e.logo) builder.logos.push(e.logo);

    const seasons = builder.item.seasons!;
    let season = seasons.find((s) => s.number === info.season);
    if (!season) {
      season = { number: info.season, episodes: [] };
      seasons.push(season);
    }

    const episode: Episode = {
      id: nextId(),
      name: e.name,
      season: info.season,
      episode: info.episode,
      url: e.url,
    };
    season.episodes.push(episode);
  }

  // For each series, pick the best cover from the episode tvg-logos using a
  // URL heuristic combined with sharing count. Providers often mix a proper
  // poster with per-episode screenshots; this prefers the shared poster when
  // it exists, and otherwise picks the URL that looks most poster-like.
  const series = [...seriesMap.values()].map(({ item, logos }) => {
    const logo = pickSeriesLogo(logos);
    return {
      ...item,
      logo,
      seasons: item.seasons!
        .sort((a, b) => a.number - b.number)
        .map((seas) => ({
          ...seas,
          episodes: [...seas.episodes].sort((a, b) => a.episode - b.episode),
        })),
    };
  });

  return { live, movies, series, epgUrl };
}
