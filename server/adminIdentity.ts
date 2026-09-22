import { prisma } from "./db";
import {
  getPublicCatalog,
  getPublicCatalogByIdentifier,
  getPublicCatalogDetail,
  type PublicCatalogDetail,
  type PublicCatalogKind,
} from "./publicCatalog";
import { normalizeTitleKey } from "./utils/titleNormalizer";

export type AdminIdentitySource = "tmdb" | "imdb" | "mal" | "anilist" | "kitsu" | "anidb" | "tvdb";

export interface AdminIdentityPreview {
  source: AdminIdentitySource;
  input: string;
  found: boolean;
  title: string | null;
  proposed: {
    tmdb_id?: number | null;
    imdb_id?: string | null;
    tvdb_id?: number | null;
    mal_id?: number | null;
    anilist_id?: string | null;
    kitsu_id?: string | null;
    anidb_id?: string | null;
  };
  source_data?: Record<string, unknown> | null;
  conflicts: {
    shows: Array<Record<string, unknown>>;
    media_items: Array<Record<string, unknown>>;
  };
  local_matches: Array<Record<string, unknown>>;
}

type AnimeIdentity = {
  title: string | null;
  mal_id: number | null;
  anilist_id: string | null;
  kitsu_id: string | null;
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function kindForCategory(category: unknown): PublicCatalogKind {
  const value = clean(category).toLowerCase();
  return value === "movie" ? "movie" : value === "series" ? "series" : "anime";
}

function positiveInt(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeInput(source: AdminIdentitySource, value: unknown): string | null {
  const raw = clean(value).replace(/\s+/g, "");
  if (!raw) return null;
  if (source === "imdb") return /^tt\d{5,12}$/i.test(raw) ? raw.toLowerCase() : null;
  if (source === "tmdb" || source === "mal" || source === "anilist" || source === "tvdb") return positiveInt(raw)?.toString() || null;
  if (source === "anidb") return /^\d+$/.test(raw) ? raw : null;
  return raw.slice(0, 120);
}

async function fetchAniListIdentity(source: "mal" | "anilist", value: string): Promise<AnimeIdentity | null> {
  const numeric = positiveInt(value);
  if (!numeric) return null;
  try {
    const variables = source === "mal" ? { idMal: numeric } : { id: numeric };
    const response = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "MeriStream/1.0" },
      body: JSON.stringify({
        query: "query ($id: Int, $idMal: Int) { Media(id: $id, idMal: $idMal, type: ANIME) { id idMal title { romaji english native } } }",
        variables,
      }),
      signal: AbortSignal.timeout(7_000),
    });
    if (response.ok) {
      const media = (await response.json() as any)?.data?.Media;
      if (media) {
        return {
          title: clean(media.title?.romaji || media.title?.english || media.title?.native) || null,
          mal_id: positiveInt(media.idMal),
          anilist_id: positiveInt(media.id)?.toString() || null,
          kitsu_id: null,
        };
      }
    }
    // AniList puede responder 403 desde algunas redes. MAL conserva una API
    // pública de respaldo que permite al menos obtener título y MAL ID para
    // continuar la propuesta y buscar el TMDB correspondiente.
    if (source === "mal") {
      const fallback = await fetch("https://api.jikan.moe/v4/anime/" + numeric, {
        headers: { Accept: "application/json", "User-Agent": "MeriStream/1.0" },
        signal: AbortSignal.timeout(7_000),
      });
      if (fallback.ok) {
        const data = (await fallback.json() as any)?.data;
        if (data) return {
          title: clean(data.title || data.title_english || data.title_japanese) || null,
          mal_id: numeric,
          anilist_id: null,
          kitsu_id: null,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchKitsuIdentity(value: string): Promise<AnimeIdentity | null> {
  try {
    const response = await fetch(`https://kitsu.io/api/edge/anime/${encodeURIComponent(value)}`, {
      headers: { Accept: "application/vnd.api+json", "User-Agent": "MeriStream/1.0" },
      signal: AbortSignal.timeout(7_000),
    });
    if (!response.ok) return null;
    const payload = await response.json() as any;
    const attributes = payload?.data?.attributes || {};
    const mappingsResponse = await fetch(`https://kitsu.io/api/edge/anime/${encodeURIComponent(value)}/mappings?page[limit]=30`, {
      headers: { Accept: "application/vnd.api+json", "User-Agent": "MeriStream/1.0" },
      signal: AbortSignal.timeout(7_000),
    });
    const mappings = mappingsResponse.ok ? await mappingsResponse.json() as any : null;
    let malId: number | null = null;
    let anilistId: string | null = null;
    for (const mapping of Array.isArray(mappings?.data) ? mappings.data : []) {
      const site = clean(mapping?.attributes?.externalSite).toLowerCase();
      const externalId = clean(mapping?.attributes?.externalId);
      if (site === "myanimelist/anime" && positiveInt(externalId)) malId = positiveInt(externalId);
      if (site === "anilist/anime" && positiveInt(externalId)) anilistId = positiveInt(externalId)?.toString() || null;
    }
    return {
      title: clean(attributes.canonicalTitle || attributes.titles?.en || attributes.titles?.ja_jp) || null,
      mal_id: malId,
      anilist_id: anilistId,
      kitsu_id: clean(payload?.data?.id) || value,
    };
  } catch {
    return null;
  }
}

async function tmdbDetailFromTitle(title: string, kind: PublicCatalogKind): Promise<PublicCatalogDetail | null> {
  const result = await getPublicCatalog({ kind, query: title, page: 1, limit: 10, mode: "search" }).catch(() => null);
  const rows = Array.isArray(result?.shows) ? result.shows : [];
  const key = normalizeTitleKey(title);
  const candidate = rows.find((row) => normalizeTitleKey(row.title) === key) || rows[0];
  return candidate ? getPublicCatalogDetail(kind, candidate.tmdb_id).catch(() => null) : null;
}

function detailToProposed(detail: PublicCatalogDetail | null): AdminIdentityPreview["proposed"] {
  if (!detail) return {};
  return {
    tmdb_id: positiveInt(detail.tmdb_id),
    imdb_id: clean(detail.imdb_id) || null,
    tvdb_id: positiveInt(detail.external_ids?.tvdb_id),
    mal_id: positiveInt(detail.mal_id),
    anilist_id: positiveInt(detail.anilist_id)?.toString() || null,
    kitsu_id: clean(detail.kitsu_id) || null,
  };
}

async function localMatches(source: AdminIdentitySource, value: string): Promise<Array<Record<string, unknown>>> {
  const field = `${source}_id`;
  const rows: Array<Record<string, unknown>> = [];
  if (["tmdb", "imdb", "tvdb", "mal", "anilist", "kitsu", "anidb"].includes(source)) {
    const shows = await prisma.show.findMany({
      where: { [field]: source === "tmdb" || source === "tvdb" || source === "mal" ? Number(value) : value } as any,
      select: { id: true, title: true, category: true, tmdb_id: true, imdb_id: true, tvdb_id: true, mal_id: true, anilist_id: true, kitsu_id: true, anidb_id: true },
      take: 20,
    });
    rows.push(...shows.map((row) => ({ entity: "show", ...row })));
    const mediaItems = await prisma.mediaItem.findMany({
      where: { [field]: source === "tmdb" || source === "tvdb" || source === "mal" ? Number(value) : value } as any,
      select: { id: true, title: true, kind: true, tmdb_id: true, imdb_id: true, tvdb_id: true, mal_id: true, anilist_id: true, kitsu_id: true, anidb_id: true },
      take: 20,
    });
    rows.push(...mediaItems.map((row) => ({ entity: "media_item", ...row })));
    if (source === "anidb") {
      const indexed = await prisma.localCatalogIndex.findMany({ where: { anidb_id: value }, take: 20 });
      rows.push(...indexed.map((row) => ({ entity: "local_index", ...row })));
    }
  }
  return rows;
}

async function conflictsFor(proposed: AdminIdentityPreview["proposed"], currentShowId: string): Promise<AdminIdentityPreview["conflicts"]> {
  const entries = Object.entries(proposed).filter(([, value]) => value !== null && value !== undefined && value !== "");
  if (entries.length === 0) return { shows: [], media_items: [] };
  const showOr = entries.map(([field, value]) => ({ [field]: value }));
  const shows = await prisma.show.findMany({
    where: { id: { not: currentShowId }, OR: showOr } as any,
    select: { id: true, title: true, category: true, tmdb_id: true, imdb_id: true, tvdb_id: true, mal_id: true, anilist_id: true, kitsu_id: true, anidb_id: true },
    take: 50,
  });
  const mediaItems = await prisma.mediaItem.findMany({
    where: { OR: showOr } as any,
    select: { id: true, title: true, kind: true, tmdb_id: true, imdb_id: true, tvdb_id: true, mal_id: true, anilist_id: true, kitsu_id: true, anidb_id: true },
    take: 50,
  });
  return { shows, media_items: mediaItems };
}

export async function previewAdminIdentity(input: {
  showId: string;
  category?: string | null;
  source: AdminIdentitySource;
  value: unknown;
}): Promise<AdminIdentityPreview> {
  const normalized = normalizeInput(input.source, input.value);
  if (!normalized) throw new Error(`El ${input.source}_id no tiene un formato válido.`);
  const proposed: AdminIdentityPreview["proposed"] = {};
  let title: string | null = null;
  let sourceData: Record<string, unknown> | null = null;

  if (input.source === "tmdb") {
    const detail = await getPublicCatalogDetail(kindForCategory(input.category), normalized).catch(() => null);
    Object.assign(proposed, detailToProposed(detail));
    title = detail?.title || null;
    sourceData = detail ? { year: detail.year, rating: detail.rating, genres: detail.genres, original_title: detail.original_title } : null;
  } else if (input.source === "imdb") {
    const result = await getPublicCatalogByIdentifier(normalized);
    const kind = kindForCategory(input.category);
    const candidate = result?.shows?.find((row) => row.kind === kind) || result?.shows?.[0];
    const detail = candidate ? await getPublicCatalogDetail(candidate.kind, candidate.tmdb_id).catch(() => null) : null;
    Object.assign(proposed, detailToProposed(detail));
    proposed.imdb_id = normalized;
    title = detail?.title || candidate?.title || null;
    sourceData = detail ? { year: detail.year, rating: detail.rating, genres: detail.genres, original_title: detail.original_title } : null;
  } else if (input.source === "mal" || input.source === "anilist") {
    const identity = await fetchAniListIdentity(input.source, normalized);
    if (identity) {
      title = identity.title;
      proposed.mal_id = identity.mal_id;
      proposed.anilist_id = identity.anilist_id;
      const detail = identity.title ? await tmdbDetailFromTitle(identity.title, "anime") : null;
      Object.assign(proposed, detailToProposed(detail), { mal_id: identity.mal_id || proposed.mal_id, anilist_id: identity.anilist_id || proposed.anilist_id });
      sourceData = detail ? { year: detail.year, rating: detail.rating, genres: detail.genres, original_title: detail.original_title } : null;
    }
  } else if (input.source === "kitsu") {
    const identity = await fetchKitsuIdentity(normalized);
    if (identity) {
      title = identity.title;
      proposed.kitsu_id = identity.kitsu_id;
      proposed.mal_id = identity.mal_id;
      proposed.anilist_id = identity.anilist_id;
      const detail = identity.title ? await tmdbDetailFromTitle(identity.title, "anime") : null;
      Object.assign(proposed, detailToProposed(detail), { kitsu_id: identity.kitsu_id, mal_id: identity.mal_id || proposed.mal_id, anilist_id: identity.anilist_id || proposed.anilist_id });
      sourceData = detail ? { year: detail.year, rating: detail.rating, genres: detail.genres, original_title: detail.original_title } : null;
    }
  } else if (input.source === "tvdb") {
    const result = await getPublicCatalogByIdentifier(`tvdb:${normalized}`).catch(() => null);
    const kind = kindForCategory(input.category);
    const candidate = result?.shows?.find((row) => row.kind === kind) || result?.shows?.[0];
    const detail = candidate ? await getPublicCatalogDetail(candidate.kind, candidate.tmdb_id).catch(() => null) : null;
    Object.assign(proposed, detailToProposed(detail));
    proposed.tvdb_id = positiveInt(normalized);
    title = detail?.title || candidate?.title || null;
    sourceData = detail ? { year: detail.year, rating: detail.rating, genres: detail.genres, original_title: detail.original_title } : null;
  } else {
    proposed[`${input.source}_id` as keyof typeof proposed] = normalized as never;
    const matches = await localMatches(input.source, normalized);
    title = clean((matches[0] as any)?.title || (matches[0] as any)?.canonical_title) || null;
    if (title) {
      const detail = await tmdbDetailFromTitle(title, kindForCategory(input.category));
      Object.assign(proposed, detailToProposed(detail));
    }
  }

  const matches = await localMatches(input.source, normalized);
  const conflicts = await conflictsFor(proposed, input.showId);
  return {
    source: input.source,
    input: normalized,
    found: Boolean(title || Object.keys(proposed).length > 0 || matches.length > 0),
    title,
    proposed,
    source_data: sourceData,
    conflicts,
    local_matches: matches,
  };
}
