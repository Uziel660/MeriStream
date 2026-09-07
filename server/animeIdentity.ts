import { normalizeBaseTitle, normalizeTitle } from "./db";

const KITSU_API = "https://kitsu.io/api/edge";
// Kitsu can take several seconds on a cold connection from the desktop host;
// this is still bounded and cached so playback does not retry it repeatedly.
const LOOKUP_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 15 * 60_000;

export interface AnimeIdentityLookup {
  aliases: string[];
  normalizedAliases: string[];
  malId: number | null;
  anilistId: number | null;
  kitsuId: string | null;
}

type CacheEntry = { expires: number; value: AnimeIdentityLookup | null };
const cache = new Map<string, CacheEntry>();

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveInt(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseInt(asText(value) || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function uniqueText(values: unknown[]): string[] {
  const seen = new Set<string>();
  return values.flatMap((value) => {
    const text = asText(value);
    const key = text?.toLowerCase();
    if (!text || !key || seen.has(key)) return [];
    seen.add(key);
    return [text];
  });
}

/** Extracts stable title aliases from a Kitsu anime record. */
export function normalizeKitsuAnimeRecord(record: unknown): AnimeIdentityLookup | null {
  if (!record || typeof record !== "object") return null;
  const item = record as Record<string, any>;
  const attributes = item.attributes && typeof item.attributes === "object" ? item.attributes : item;
  const titles = attributes.titles && typeof attributes.titles === "object" ? attributes.titles : {};
  const aliases = uniqueText([
    attributes.canonicalTitle,
    titles.en,
    titles.en_jp,
    titles.ja_jp,
    ...(Array.isArray(attributes.abbreviatedTitles) ? attributes.abbreviatedTitles : []),
  ]);
  const normalizedAliases = uniqueText(aliases.flatMap((alias) => [normalizeTitle(alias), normalizeBaseTitle(alias)]));
  const kitsuId = asText(item.id) || null;
  if (aliases.length === 0 && !kitsuId) return null;
  return {
    aliases,
    normalizedAliases,
    malId: null,
    anilistId: null,
    kitsuId,
  };
}

async function fetchJson(url: string): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/vnd.api+json, application/json" },
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolves alternate anime titles through Kitsu's public API. This is only a
 * metadata bridge: it never fetches or bypasses media, and a network failure
 * simply leaves the local title matching unchanged.
 */
export async function lookupAnimeIdentityByTitle(title: string): Promise<AnimeIdentityLookup | null> {
  const key = normalizeTitle(title);
  if (!key) return null;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;

  const url = `${KITSU_API}/anime?filter[text]=${encodeURIComponent(title)}&page[limit]=5`;
  const payload = await fetchJson(url);
  const records = Array.isArray(payload?.data) ? payload.data : [];
  const ranked = records
    .map((record: any) => ({ record, identity: normalizeKitsuAnimeRecord(record) }))
    .filter((entry: any) => entry.identity)
    .sort((a: any, b: any) => {
      const aExact = a.identity.normalizedAliases.includes(key) ? 1 : 0;
      const bExact = b.identity.normalizedAliases.includes(key) ? 1 : 0;
      return bExact - aExact;
    });
  const selected = ranked[0];
  if (!selected) {
    cache.set(key, { expires: Date.now() + 60_000, value: null });
    return null;
  }

  const identity: AnimeIdentityLookup = selected.identity;
  const kitsuId = identity.kitsuId;
  if (kitsuId) {
    const mappings = await fetchJson(`${KITSU_API}/anime/${encodeURIComponent(kitsuId)}/mappings?page[limit]=20`);
    for (const mapping of Array.isArray(mappings?.data) ? mappings.data : []) {
      const externalSite = String(mapping?.attributes?.externalSite || "").toLowerCase();
      const externalId = mapping?.attributes?.externalId;
      if (externalSite === "myanimelist/anime") identity.malId ||= positiveInt(externalId);
      if (externalSite === "anilist/anime") identity.anilistId ||= positiveInt(externalId);
    }
  }

  cache.set(key, { expires: Date.now() + CACHE_TTL_MS, value: identity });
  return identity;
}

export function clearAnimeIdentityCache(): void {
  cache.clear();
}
