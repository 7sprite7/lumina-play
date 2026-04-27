import type { EpgProgram } from "../types";

// XMLTV format reference: https://wiki.xmltv.org/index.php/XMLTVFormat
//
//   <tv>
//     <channel id="some-id"><display-name>Foo</display-name></channel>
//     <programme channel="some-id" start="20240427180000 +0000" stop="20240427183000 +0000">
//       <title>Programme name</title>
//       <desc>Optional description</desc>
//     </programme>
//   </tv>
//
// We use the browser/webview-built-in DOMParser to avoid pulling a heavy XML
// library. For the typical 5–50 MB XMLTV files we deal with, DOMParser
// processes everything in a few hundred ms — done once after fetch.

// Channel id (== `tvg-id` in the M3U) → list of programmes sorted by start.
export type EpgIndex = Record<string, EpgProgram[]>;

// Parse an XMLTV "20240427180000 +0000" timestamp into milliseconds since
// epoch. Returns null on malformed input.
export function parseXmltvDate(s: string): number | null {
  if (!s) return null;
  // Some providers omit the trailing offset (assume UTC) or use forms like
  // "+00:00". Be liberal in what we accept.
  const m = s.trim().match(
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-]\d{2})(\d{2})?)?$/
  );
  if (!m) return null;
  const [, y, mo, d, h, mi, se, tzh, tzm] = m;
  const tz = tzh ? `${tzh}:${tzm ?? "00"}` : "+00:00";
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${se}${tz}`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

export function parseXmltv(xml: string): EpgIndex {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, "application/xml");

  // DOMParser doesn't throw on malformed input — instead it returns a
  // <parsererror> root. Detect that early and bail.
  if (doc.querySelector("parsererror")) {
    console.warn("[xmltv] failed to parse XML");
    return {};
  }

  const out: EpgIndex = {};
  const programmes = doc.getElementsByTagName("programme");
  for (let i = 0; i < programmes.length; i++) {
    const p = programmes[i];
    const channel = p.getAttribute("channel");
    if (!channel) continue;
    const start = parseXmltvDate(p.getAttribute("start") ?? "");
    const stop = parseXmltvDate(p.getAttribute("stop") ?? "");
    if (start === null || stop === null) continue;

    const titleEl = p.getElementsByTagName("title")[0];
    const descEl = p.getElementsByTagName("desc")[0];
    const title = titleEl?.textContent?.trim() ?? "";
    if (!title) continue;

    const program: EpgProgram = {
      title,
      description: descEl?.textContent?.trim() || undefined,
      start,
      stop,
    };

    let arr = out[channel];
    if (!arr) {
      arr = [];
      out[channel] = arr;
    }
    arr.push(program);
  }

  // Sort each channel's programmes ascending by start so "now playing" lookup
  // is a single linear scan.
  for (const k in out) {
    out[k].sort((a, b) => a.start - b.start);
  }

  return out;
}

// Pick the program currently airing + the next N upcoming for a given channel.
export function programsAround(
  index: EpgIndex,
  channelId: string | undefined,
  now: number = Date.now(),
  upcoming = 1
): EpgProgram[] {
  if (!channelId) return [];
  const list = index[channelId];
  if (!list || list.length === 0) return [];

  // Find current (start <= now < stop). Linear scan is fine — typical channel
  // has a few hundred programmes, tens of thousands at worst.
  let nowIdx = -1;
  for (let i = 0; i < list.length; i++) {
    if (list[i].start <= now && now < list[i].stop) {
      nowIdx = i;
      break;
    }
    if (list[i].start > now) {
      // We passed `now` without finding an active programme — fall back to
      // returning the next upcoming entry, plus its successors.
      nowIdx = i;
      break;
    }
  }

  if (nowIdx < 0) return [];

  const out: EpgProgram[] = [];
  const current = list[nowIdx];
  const isLive = current.start <= now && now < current.stop;
  out.push({ ...current, nowPlaying: isLive });

  for (let i = 1; i <= upcoming; i++) {
    const next = list[nowIdx + i];
    if (next) out.push(next);
  }
  return out;
}
