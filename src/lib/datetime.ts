import type { DateFormat, Language, TimeFormat } from "../types";

export function formatDate(date: Date, format: DateFormat, lang: Language): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const d = pad(date.getDate());
  const m = pad(date.getMonth() + 1);
  const y = date.getFullYear();
  switch (format) {
    case "mmddyyyy":
      return lang === "pt" ? `${m}/${d}/${y}` : `${m}/${d}/${y}`;
    case "iso":
      return `${y}-${m}-${d}`;
    case "ddmmyyyy":
    default:
      return `${d}/${m}/${y}`;
  }
}

export function formatTime(date: Date, format: TimeFormat): string {
  return date.toLocaleTimeString(format === "12h" ? "en-US" : "pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: format === "12h",
  });
}

export function localeFor(lang: Language): string {
  return lang === "en" ? "en-US" : "pt-BR";
}
