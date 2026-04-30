// Version-update checker. Polls GitHub Releases API (or a custom JSON
// manifest) for the latest published version and compares with the
// app's own version (injected at build time via Vite's `define`).
//
// IMPORTANT for private repos:
//
// GitHub's REST endpoint `/repos/<owner>/<repo>/releases/latest` returns
// 404 for private repos without an auth token. If the lumina-play repo
// stays private, you have two practical workarounds:
//
//   1. Publish a tiny `latest.json` manifest somewhere PUBLIC (a GitHub
//      Pages site, a Gist's raw URL, or your own VPS) and set
//      `UPDATE_MANIFEST_URL` to that. Shape:
//        {
//          "version": "0.1.7",
//          "html_url": "https://github.com/7sprite7/lumina-play/releases/tag/v0.1.7"
//        }
//      Update it manually after each release, or via a small CI step.
//
//   2. Make the lumina-play repo public. Releases follow repo visibility
//      so the API call would succeed.
//
// The default below points at the GitHub API; flip the constant when
// switching to a custom manifest.

import { IS_TAURI } from "./platform";

const REPO_OWNER = "7sprite7";
const REPO_NAME = "lumina-play";

// Default endpoint — works only if the repo (and its releases) are public.
// Replace with a custom URL if you keep the repo private.
const UPDATE_MANIFEST_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;

// Auto-injected by Vite's `define` config — see vite.config.ts.
declare const __APP_VERSION__: string;
export const APP_VERSION = __APP_VERSION__;

export interface ReleaseInfo {
  version: string; // semver "0.1.7" — the leading "v" is stripped if present
  url: string; // release page URL
  notes?: string; // markdown body, when present
  publishedAt?: string; // ISO timestamp
}

interface GithubReleaseShape {
  tag_name?: string;
  name?: string;
  html_url?: string;
  body?: string;
  published_at?: string;
  draft?: boolean;
  prerelease?: boolean;
}

interface CustomManifestShape {
  version?: string;
  html_url?: string;
  url?: string;
  notes?: string;
  publishedAt?: string;
  published_at?: string;
}

export async function fetchLatestRelease(): Promise<ReleaseInfo | null> {
  try {
    let res: Response;
    const headers = { Accept: "application/json" };
    if (IS_TAURI) {
      const { fetch: tFetch } = await import("@tauri-apps/plugin-http");
      res = (await tFetch(UPDATE_MANIFEST_URL, {
        method: "GET",
        headers,
      })) as unknown as Response;
    } else {
      res = await fetch(UPDATE_MANIFEST_URL, { method: "GET", headers });
    }
    if (!res.ok) return null;
    const data = (await res.json()) as GithubReleaseShape & CustomManifestShape;

    // Skip drafts / pre-releases when responding from the GitHub API.
    if (data.draft || data.prerelease) return null;

    const rawVersion = data.version ?? data.tag_name;
    if (!rawVersion) return null;
    const version = String(rawVersion).replace(/^v/, "");

    return {
      version,
      url: data.html_url ?? data.url ?? `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`,
      notes: data.body ?? data.notes,
      publishedAt: data.published_at ?? data.publishedAt,
    };
  } catch {
    return null;
  }
}

// Returns positive if a > b, negative if a < b, 0 if equal. Numeric semver
// only (no pre-release suffixes) — fits our 0.1.x scheme.
export function compareVersions(a: string, b: string): number {
  const ap = a.split(".").map((p) => parseInt(p, 10) || 0);
  const bp = b.split(".").map((p) => parseInt(p, 10) || 0);
  const len = Math.max(ap.length, bp.length);
  for (let i = 0; i < len; i++) {
    const av = ap[i] ?? 0;
    const bv = bp[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

export function isUpdateAvailable(latest: string, current = APP_VERSION): boolean {
  return compareVersions(latest, current) > 0;
}
