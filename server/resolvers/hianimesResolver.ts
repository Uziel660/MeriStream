const API_BASES = ["https://animehot.cc/api", "https://anitv.cfd/api"] as const;
const HIANIMES_HOST = "hianimes.se";
const DEFAULT_TIMEOUT_MS = 8_000;

export interface HianimesEpisodeLinkSet {
  sub: string[];
  dub: string[];
}

export interface HianimesEpisodeRecord {
  slug: string;
  title: string;
  episodeNumber: number;
  link: HianimesEpisodeLinkSet;
}

export interface HianimesAnimeRecord {
  slug: string;
  title: string;
  englishTitle?: string;
  japaneseTitle?: string;
  synopsis?: string;
  type?: string;
  status?: string;
  aired?: string;
  score?: string;
  rating?: string;
  image?: string;
  landscapeImage?: string;
  genres: string[];
  episodes: HianimesEpisodeRecord[];
}

export interface HianimesFilterResult {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  results: Array<Record<string, unknown>>;
}

export function isHianimesUrl(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
    return host === HIANIMES_HOST || host.endsWith(`.${HIANIMES_HOST}`);
  } catch {
    return false;
  }
}

export function isHianimesWatchUrl(rawUrl: string): boolean {
  try {
    return isHianimesUrl(rawUrl) && new URL(rawUrl).pathname.toLowerCase().startsWith("/watch/");
  } catch {
    return false;
  }
}

export function hianimesSlugFromUrl(rawUrl: string): string | undefined {
  try {
    const parts = new URL(rawUrl).pathname.split("/").filter(Boolean);
    const index = parts.findIndex((part) => part.toLowerCase() === "watch" || part.toLowerCase() === "details");
    const slug = index >= 0 ? parts[index + 1] : undefined;
    return slug ? decodeURIComponent(slug).trim() : undefined;
  } catch {
    return undefined;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const text = asString(entry);
    return text ? [text] : [];
  });
}

function asLinkSet(value: unknown): HianimesEpisodeLinkSet {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const clean = (entry: unknown) => asStringArray(entry).filter((url) => /^https?:\/\//i.test(url));
  return { sub: clean(record.sub), dub: clean(record.dub) };
}

function asEpisode(value: unknown): HianimesEpisodeRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const slug = asString(item.slug) || asString(Array.isArray(item.slugs) ? item.slugs[0] : undefined);
  if (!slug) return undefined;
  const number = typeof item.episodeNumber === "number" && Number.isFinite(item.episodeNumber)
    ? item.episodeNumber
    : Number.parseInt(asString(item.episodeNumber) || "", 10);
  return {
    slug,
    title: asString(item.title) || `Episode ${Number.isFinite(number) && number > 0 ? number : 1}`,
    episodeNumber: Number.isFinite(number) && number > 0 ? number : 1,
    link: asLinkSet(item.link),
  };
}

export function normalizeAnimeRecord(value: unknown): HianimesAnimeRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const title = asString(item.title) || asString(item.English) || asString(item.Japanese) || asString(item.slug);
  const slug = asString(item.slug) || asString(Array.isArray(item.slugs) ? item.slugs[0] : undefined);
  if (!title || !slug) return undefined;
  return {
    slug,
    title,
    englishTitle: asString(item.English),
    japaneseTitle: asString(item.Japanese),
    synopsis: asString(item.synopsis),
    type: asString(item.Type),
    status: asString(item.Status),
    aired: asString(item.Aired),
    score: asString(item.Score),
    rating: asString(item.Rating),
    image: asString(item.image),
    landscapeImage: asString(item.landScapeImage),
    genres: asStringArray(item.genres),
    episodes: Array.isArray(item.episodes) ? item.episodes.flatMap((ep) => {
      const normalized = asEpisode(ep);
      return normalized ? [normalized] : [];
    }) : [],
  };
}

async function requestApi(path: string, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (const base of API_BASES) {
      try {
        const response = await fetch(`${base}${path}`, {
          ...init,
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Origin: "https://hianimes.se",
            Referer: "https://hianimes.se/",
            ...(init.headers || {}),
          },
        });
        if (response.ok) return await response.json();
      } catch {
        // Try the configured fallback API while the same deadline remains active.
      }
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchHianimesFilter(page: number, limit = 20, type = "All"): Promise<HianimesFilterResult | null> {
  const payload = await requestApi("/filter", {
    method: "POST",
    body: JSON.stringify({ page, limit, type }),
  });
  if (!payload || typeof payload !== "object") return null;
  const raw = payload as Record<string, unknown>;
  const results = Array.isArray(raw.results) ? raw.results.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object")) : [];
  const number = (value: unknown, fallback: number) => {
    const parsed = typeof value === "number" ? value : Number.parseInt(asString(value) || "", 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    total: number(raw.total, results.length),
    page: number(raw.page, page),
    limit: number(raw.limit, limit),
    totalPages: number(raw.totalPages, page),
    results,
  };
}

export async function fetchHianimesAnime(slug: string): Promise<HianimesAnimeRecord | null> {
  const payload = await requestApi(`/anime/${encodeURIComponent(slug)}`);
  if (!payload || typeof payload !== "object") return null;
  const raw = payload as Record<string, unknown>;
  return normalizeAnimeRecord(raw.anime ?? payload);
}

export async function fetchHianimesEpisode(slug: string): Promise<{ anime: HianimesAnimeRecord | null; episode: HianimesEpisodeRecord | null }> {
  const payload = await requestApi(`/episode/${encodeURIComponent(slug)}`);
  if (!payload || typeof payload !== "object") return { anime: null, episode: null };
  const raw = payload as Record<string, unknown>;
  const episode = asEpisode(raw.episode);
  const anime = normalizeAnimeRecord(raw.anime);
  return { anime: anime || null, episode: episode || null };
}

/** Returns provider links in deterministic preference order (sub before dub). */
export function episodeLinks(episode: HianimesEpisodeRecord): Array<{ url: string; language: "sub" | "dub"; index: number }> {
  return ([
    ...episode.link.sub.map((url, index) => ({ url, language: "sub" as const, index })),
    ...episode.link.dub.map((url, index) => ({ url, language: "dub" as const, index })),
  ]);
}
