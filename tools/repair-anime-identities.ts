#!/usr/bin/env node
/**
 * Completa MAL/AniList para los anime legacy sin sobrescribir identidades
 * existentes. La consulta usa varios títulos y una puntuación conservadora;
 * una coincidencia dudosa se informa como pendiente en vez de inventar un ID.
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { findLocalAnimeIdentity } from "../server/localCatalogIndex";
import { decodeHtmlEntities, normalizeTitleKey } from "../server/utils/titleNormalizer";

type AnimeCandidate = {
  id: number;
  anilistId?: string | null;
  idMal?: number | null;
  title?: { romaji?: string | null; english?: string | null; native?: string | null; en_us?: string | null } | null;
  synonyms?: string[] | null;
  startDate?: { year?: number | null } | null;
  kitsuId?: string | null;
  externalMatch?: "exact" | "contained";
};

type Result = {
  showId: string;
  title: string;
  matchedTitle?: string;
  tmdbId?: number;
  anilistId?: string;
  malId?: number;
  score?: number;
  status: "updated" | "unresolved" | "skipped" | "conflict";
  reason?: string;
};

const prisma = new PrismaClient();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let aniListUnavailable = false;
const wikidataCache = new Map<number, { malId: number | null; anilistId: string | null } | null>();
const malWikidataCache = new Map<number, { malId: number | null; anilistId: string | null } | null>();
const kitsuResponseCache = new Map<string, any | null>();
const PRIMARY_SOURCES = ["cinecalidad", "latanime", "gnula", "tioanime"];

// Aliases de proveedores verificados contra los mappings MAL/AniList de Kitsu.
// Se mantienen aquí solo cuando la traducción no es recuperable por búsqueda
// automática y la obra/temporada es inequívoca.
const CURATED_IDENTITIES: Record<string, { malId: number; anilistId: string }> = {
  condenadoaserunheroe: { malId: 56009, anilistId: "167152" },
  elsenorloboquieresercomido: { malId: 42517, anilistId: "121797" },
  inuyasha4: { malId: 449, anilistId: "449" },
  haikyuoad2elrivalsonlossuspensos: { malId: 35806, anilistId: "21348" },
  natsumeyuujinchos3: { malId: 10379, anilistId: "10379" },
  nanatsunotaizaimovie1: { malId: 35946, anilistId: "99540" },
  azurlanebisokuzenshinespecial: { malId: 49487, anilistId: "139752" },
  comicpartyespeciales: { malId: 707, anilistId: "707" },
  thekingsavatarmovieforthegloryquanzhigaoshouzhidianfengrongyao: { malId: 40080, anilistId: "108981" },
  doupocangqiongespecialesbattlethroughtheheavensespeciales: { malId: 36561, anilistId: "102462" },
  codegeassleloucheldelarebellioniiniciacion: { malId: 34438, anilistId: "101811" },
  codegeassleloucheldelarebelioniitransgresion: { malId: 34439, anilistId: "101812" },
  codegeassleloucheldelarebelioniiiglorificacion: { malId: 34440, anilistId: "101813" },
  elcantodelanoches2: { malId: 58390, anilistId: "175914" },
  laeminenciaenlasombras2: { malId: 54595, anilistId: "161964" },
  sakuracardcaptor2: { malId: 372, anilistId: "372" },
  alyaavecesescondesussentimientosenruso: { malId: 54744, anilistId: "162804" },
  dragonballzelrenacerdelafusiongokuyvegeta: { malId: 905, anilistId: "905" },
  overflowdesbordandose: { malId: 40746, anilistId: "113417" },
  zenkielguerreroguardian: { malId: 1573, anilistId: "1573" },
  luchadorasdeleyendarayearthova: { malId: 1954, anilistId: "1954" },
  sanshasanyouespeciales: { malId: 33173, anilistId: "21789" },
  doupocangqiong2especialesbattlethroughtheheavens2songofdesert: { malId: 39178, anilistId: "109484" },
  ulibyeolilhowaeollugsolachicasateliteyelchicovaca: { malId: 28251, anilistId: "102557" },
  nisekoisegunda: { malId: 27787, anilistId: "20876" },
  maiotomeespeciales: { malId: 1659, anilistId: "1659" },
  akamegakillakakillgekijou: { malId: 25241, anilistId: "20775" },
  hatarakusaibouespeciales: { malId: 39605, anilistId: "109085" },
  sonobisquedollwakoiwosurus2: { malId: 53065, anilistId: "154768" },
  freemovie4thefinalstroke: { malId: 38400, anilistId: "107203" },
  nekoparaanime: { malId: 38924, anilistId: "106863" },
  azurlaneminidrama: { malId: 38328, anilistId: "104159" },
};

// Algunas obras de catálogo oficial sí tienen ficha AniList, pero no una
// referencia MAL. Se guardan aparte para no inventar un MAL ni bloquear la
// reparación por la restricción única de esa columna.
const CURATED_ANILIST_ONLY: Record<string, string> = {
  "superchicamovil⅙": "104284",
  starwarsvisions2: "184642",
};

function args() {
  const argv = process.argv.slice(2);
  const value = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const limit = Number(value("--limit"));
  const concurrency = Number(value("--concurrency"));
  return {
    apply: argv.includes("--apply"),
    onlyNone: argv.includes("--only-none"),
    primaryOnly: argv.includes("--primary-only"),
    limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : undefined,
    concurrency: Math.min(6, Math.max(1, Number.isFinite(concurrency) ? Math.floor(concurrency) : 3)),
    delayMs: Math.max(250, Number(value("--delay-ms") || 600)),
    report: value("--report"),
    afterId: value("--after-id"),
  };
}

function clean(value: unknown): string {
  return decodeHtmlEntities(String(value || ""))
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(?:season|temporada|part|cour|cour\s+\d+|s\s*\d+)\s*\d*\b/gi, " ")
    .replace(/\b(?:tv|movie|film|ova|ona|special|speciales|recap|netflix|amz|amazon|latino|castellano|catalan|catalán|bd|remaster|remastered|sin\s+censura|uncensored|live\s+action)\b/gi, " ")
    // A year belongs to the matching guard below, not to the title token set;
    // this lets "Ranma1/2" match the catalog title "Ranma 1/2 (2024)" while
    // still rejecting a sequel whose year differs materially.
    .replace(/\b(?:19|20)\d{2}\b/g, " ")
    .replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(value: string): Set<string> {
  return new Set(clean(value).split(" ").filter((token) => token.length > 1));
}

function similarity(left: string, right: string): number {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const token of a) if (b.has(token)) common += 1;
  return common / Math.max(a.size, b.size);
}

function candidateTitles(candidate: AnimeCandidate): string[] {
  return [candidate.title?.romaji, candidate.title?.english, candidate.title?.native, candidate.title?.en_us, ...(candidate.synonyms || [])]
    .map((value) => String(value || "").trim())
    .filter((value, index, values) => value && values.findIndex((item) => clean(item) === clean(value)) === index);
}

async function fetchWikidataIdentity(tmdbId: number): Promise<{ malId: number | null; anilistId: string | null } | null> {
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) return null;
  if (wikidataCache.has(tmdbId)) return wikidataCache.get(tmdbId) || null;
  try {
    const query = `SELECT ?mal ?anilist WHERE { ?item wdt:P4983 "${tmdbId}". OPTIONAL { ?item wdt:P4086 ?mal. } OPTIONAL { ?item wdt:P8729 ?anilist. } } LIMIT 1`;
    const url = new URL("https://query.wikidata.org/sparql");
    url.searchParams.set("format", "json");
    url.searchParams.set("query", query);
    const response = await fetch(url, {
      headers: { accept: "application/sparql-results+json", "user-agent": "MeriStream/1.0 (identity repair)" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      wikidataCache.set(tmdbId, null);
      return null;
    }
    const binding = ((await response.json() as any)?.results?.bindings || [])[0];
    const mal = String(binding?.mal?.value || "");
    const anilist = String(binding?.anilist?.value || "");
    const result = {
      malId: /^\d+$/.test(mal) ? Number(mal) : null,
      anilistId: /^\d+$/.test(anilist) ? anilist : null,
    };
    wikidataCache.set(tmdbId, result);
    return result.malId || result.anilistId ? result : null;
  } catch {
    wikidataCache.set(tmdbId, null);
    return null;
  }
}

async function fetchWikidataByMal(malId: number): Promise<{ malId: number | null; anilistId: string | null } | null> {
  if (!Number.isInteger(malId) || malId <= 0) return null;
  if (malWikidataCache.has(malId)) return malWikidataCache.get(malId) || null;
  try {
    const query = `SELECT ?tmdb ?anilist WHERE { ?item wdt:P4086 "${malId}". OPTIONAL { ?item wdt:P4983 ?tmdb. } OPTIONAL { ?item wdt:P8729 ?anilist. } } LIMIT 1`;
    const url = new URL("https://query.wikidata.org/sparql");
    url.searchParams.set("format", "json");
    url.searchParams.set("query", query);
    const response = await fetch(url, {
      headers: { accept: "application/sparql-results+json", "user-agent": "MeriStream/1.0 (identity repair)" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      malWikidataCache.set(malId, null);
      return null;
    }
    const binding = ((await response.json() as any)?.results?.bindings || [])[0];
    const anilist = String(binding?.anilist?.value || "");
    const result = {
      malId,
      anilistId: /^\d+$/.test(anilist) ? anilist : null,
    };
    malWikidataCache.set(malId, result.anilistId ? result : null);
    return result.anilistId ? result : null;
  } catch {
    malWikidataCache.set(malId, null);
    return null;
  }
}

async function searchAniList(query: string): Promise<AnimeCandidate | null> {
  if (aniListUnavailable) return null;
  const response = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": "MeriStream/1.0" },
    body: JSON.stringify({
      query: `query ($search: String) { Media(search: $search, type: ANIME) { id idMal title { romaji english native } synonyms startDate { year } } }`,
      variables: { search: query },
    }),
    signal: AbortSignal.timeout(2_500),
  });
  if (!response.ok) {
    // AniList currently answers with a service-level 403. Avoid retrying the
    // same unavailable endpoint for every alias in a batch; Kitsu remains the
    // no-key fallback.
    aniListUnavailable = true;
    return null;
  }
  return ((await response.json() as any)?.data?.Media || null) as AnimeCandidate | null;
}

async function searchKitsu(query: string): Promise<AnimeCandidate | null> {
  const searchUrl = new URL("https://kitsu.io/api/edge/anime");
  searchUrl.searchParams.set("filter[text]", query);
  searchUrl.searchParams.set("page[limit]", "5");
  const payload = await fetchKitsuJson(searchUrl.toString());
  if (!payload) return null;
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  let best: AnimeCandidate | null = null;
  let bestScore = 0;
  for (const row of rows) {
    const attributes = row?.attributes || {};
    const titles = [attributes.canonicalTitle, attributes.titles?.canonical, ...Object.values(attributes.titles || {}), attributes.slug]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    const queryClean = clean(query);
    const collectionQuery = /\bmovies?\b/i.test(query) && !/\bmovie\s*\d+\b/i.test(query);
    const miniDramaQuery = /\bmini\s+drama\b/i.test(query);
    const exact = !collectionQuery && !miniDramaQuery && titles.some((title) => clean(title) === queryClean);
    const contained = titles.some((title) => {
      const titleClean = clean(title);
      const candidateHasMiniDrama = /\bmini\s+drama\b/i.test(title);
      const candidateHasMovieMarker = /\bmovie\b/i.test(title);
      const structureCompatible = !collectionQuery && (!miniDramaQuery || candidateHasMiniDrama)
        && (!/\bmovie\s+\d+\b/i.test(query) || candidateHasMovieMarker);
      return structureCompatible && titleClean.length >= 6 && (queryClean.includes(titleClean) || titleClean.includes(queryClean));
    });
    const score = Math.max(...titles.map((title) => similarity(query, title)), 0);
    if (score > bestScore) {
      bestScore = score;
      best = {
        id: Number(row.id) || 0,
        anilistId: null,
        idMal: null,
        title: { romaji: attributes.titles?.en_jp || attributes.titles?.canonical, english: attributes.titles?.en || attributes.titles?.en_us, native: attributes.titles?.ja_jp, en_us: attributes.titles?.en_us },
        synonyms: titles,
        startDate: { year: Number(String(attributes.startDate || attributes.start_date || "").slice(0, 4)) || null },
        kitsuId: String(row.id || ""),
        externalMatch: exact ? "exact" : contained ? "contained" : undefined,
      };
    }
  }
  if (!best?.kitsuId) return null;
  const mappingsPayload = await fetchKitsuJson(`https://kitsu.io/api/edge/anime/${encodeURIComponent(best.kitsuId)}/mappings`);
  if (mappingsPayload) {
    const mappings = mappingsPayload?.data;
    if (Array.isArray(mappings)) {
      const mal = mappings.find((entry: any) => entry?.attributes?.externalSite === "myanimelist/anime")?.attributes?.externalId;
      const anilist = mappings.find((entry: any) => entry?.attributes?.externalSite === "anilist/anime")?.attributes?.externalId;
      best.idMal = /^\d+$/.test(String(mal || "")) ? Number(mal) : null;
      if (anilist && /^\d+$/.test(String(anilist))) best.anilistId = String(anilist);
    }
  }
  return best;
}

async function fetchKitsuJson(url: string): Promise<any | null> {
  if (kitsuResponseCache.has(url)) return kitsuResponseCache.get(url) || null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { headers: { accept: "application/vnd.api+json", "user-agent": "MeriStream/1.0" }, signal: AbortSignal.timeout(4_000) });
      if (response.ok) {
        const payload = await response.json() as any;
        kitsuResponseCache.set(url, payload);
        return payload;
      }
      if (response.status !== 429 && response.status < 500) break;
      const retryAfter = Number(response.headers.get("retry-after") || 0);
      await sleep(Math.min(6_000, Math.max(1_000, retryAfter * 1_000 || 1_500)));
    } catch {
      if (attempt < 2) await sleep(1_000);
    }
  }
  kitsuResponseCache.set(url, null);
  return null;
}

function reliableAnimeYear(value: unknown): number | null {
  const year = Number(value);
  // 1969/1912 are legacy importer defaults present in old source rows, not
  // reliable air dates. Keeping them would reject otherwise exact MAL hits.
  return Number.isInteger(year) && year >= 1930 && year <= 2100 && year !== 1969 ? year : null;
}

function providerNoiseVariant(value: unknown): string {
  return String(value || "")
    .replace(/\b(?:netflix|amz|amazon|amc|ia|latino|castellano|catalan|catalán|bd|remaster|remastered)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function searchJikan(query: string): Promise<AnimeCandidate | null> {
  const url = new URL("https://api.jikan.moe/v4/anime");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "5");
  url.searchParams.set("sfw", "true");
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "MeriStream/1.0 (identity repair)" },
    signal: AbortSignal.timeout(4_000),
  });
  if (!response.ok) return null;
  const rows = ((await response.json() as any)?.data || []) as any[];
  let best: AnimeCandidate | null = null;
  let bestScore = 0;
  for (const row of rows) {
    const titles = [
      row?.title,
      row?.title_english,
      row?.title_japanese,
      ...(Array.isArray(row?.titles) ? row.titles.map((item: any) => item?.title) : []),
    ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    const score = Math.max(...titles.map((title) => similarity(query, title)), 0);
    const year = Number(String(row?.aired?.from || row?.year || "").slice(0, 4)) || null;
    if (score > bestScore) {
      bestScore = score;
      best = {
        id: 0,
        idMal: Number(row?.mal_id) || null,
        anilistId: null,
        title: { romaji: row?.title, english: row?.title_english, native: row?.title_japanese },
        synonyms: titles,
        startDate: { year },
      };
    }
  }
  return best;
}

async function resolve(row: any): Promise<Result> {
  // Existing MAL IDs are trusted and must never be replaced by a fuzzy title
  // match. They can still be enriched safely through the exact MAL→AniList
  // edge in Wikidata, which fixes the common "MAL present, AniList missing"
  // case without touching playback identity.
  if (row.mal_id && !row.anilist_id) {
    const byMal = await fetchWikidataByMal(Number(row.mal_id));
    if (byMal?.anilistId) {
      if (args().apply) {
        await prisma.show.update({ where: { id: row.id }, data: { anilist_id: byMal.anilistId } });
      }
      return {
        showId: row.id,
        title: row.title,
        anilistId: byMal.anilistId,
        malId: Number(row.mal_id),
        score: 1,
        status: "updated",
        reason: "exact_mal_wikidata",
      };
    }
  }
  if (!row.tmdb_id && !row.mal_id && !row.anilist_id) {
    const curated = CURATED_IDENTITIES[normalizeTitleKey(row.title)];
    if (curated) {
      const existingMal = await prisma.show.findUnique({ where: { mal_id: curated.malId }, select: { id: true } });
      const safeMalId = !existingMal || existingMal.id === row.id ? curated.malId : null;
      const data = {
        ...(safeMalId ? { mal_id: safeMalId } : {}),
        anilist_id: curated.anilistId,
      };
      if (args().apply) await prisma.show.update({ where: { id: row.id }, data });
      return {
        showId: row.id,
        title: row.title,
        ...(safeMalId ? { malId: safeMalId } : {}),
        anilistId: curated.anilistId,
        score: 1,
        status: "updated",
        reason: safeMalId ? "curated_external_mapping" : "curated_anilist_duplicate_mal",
      };
    }
    const curatedAniList = CURATED_ANILIST_ONLY[normalizeTitleKey(row.title)];
    if (curatedAniList) {
      if (args().apply) await prisma.show.update({ where: { id: row.id }, data: { anilist_id: curatedAniList } });
      return {
        showId: row.id,
        title: row.title,
        anilistId: curatedAniList,
        score: 1,
        status: "updated",
        reason: "curated_anilist_only_mapping",
      };
    }
  }
  // Una misma obra puede haber entrado varias veces desde temporadas o
  // proveedores distintos. Si otra fila anime comparte exactamente el título
  // normalizado/base y tiene una única identidad externa, heredamos solo los
  // campos que no contradicen la fila actual. No usamos una base compartida
  // cuando aparecen dos MAL/AniList distintos (secuela/franquicia ambigua).
  const providerKey = normalizeTitleKey(providerNoiseVariant(row.title));
  const siblingKeys = [...new Set([row.normalized_title, row.base_normalized_title, providerKey])]
    .filter((value: unknown): value is string => Boolean(value));
  if (siblingKeys.length) {
    const siblings = await prisma.show.findMany({
      where: {
        id: { not: row.id },
        category: "anime",
        OR: [
          { normalized_title: { in: siblingKeys } },
          { base_normalized_title: { in: siblingKeys } },
        ],
        AND: [{ OR: [{ tmdb_id: { not: null } }, { mal_id: { not: null } }, { anilist_id: { not: null } }] }],
      },
      select: { tmdb_id: true, mal_id: true, anilist_id: true },
      take: 50,
    });
    const siblingTmdbIds = [...new Set(siblings.map((item) => item.tmdb_id).filter((value): value is number => Number.isInteger(value) && value > 0))];
    const siblingMalIds = [...new Set(siblings.map((item) => item.mal_id).filter((value): value is number => Number.isInteger(value) && value > 0))];
    const siblingAniIds = [...new Set(siblings.map((item) => item.anilist_id).filter((value): value is string => Boolean(value)))];
    const siblingTmdbId = siblingTmdbIds.length === 1 ? siblingTmdbIds[0] : null;
    const siblingMalId = siblingMalIds.length === 1 ? siblingMalIds[0] : null;
    const siblingAniId = siblingAniIds.length === 1 ? siblingAniIds[0] : null;
    const siblingAniData = siblingAniId && !row.anilist_id ? { anilist_id: siblingAniId } : {};
    if (siblingTmdbId || siblingAniId || (siblingMalId && !row.mal_id)) {
      const existingMal = siblingMalId
        ? await prisma.show.findUnique({ where: { mal_id: siblingMalId }, select: { id: true } })
        : null;
      const safeMalId = siblingMalId && (!existingMal || existingMal.id === row.id) ? siblingMalId : null;
      const data = {
        ...(siblingTmdbId && !row.tmdb_id ? { tmdb_id: siblingTmdbId } : {}),
        ...(safeMalId ? { mal_id: safeMalId } : {}),
        ...siblingAniData,
      };
      if (Object.keys(data).length > 0) {
        if (args().apply) await prisma.show.update({ where: { id: row.id }, data });
        return {
          showId: row.id,
          title: row.title,
          ...(safeMalId ? { malId: safeMalId } : {}),
          ...(siblingAniId ? { anilistId: siblingAniId } : {}),
          score: 1,
          status: "updated",
          reason: "sibling_identity_exact",
        };
      }
    }
  }
  // El índice local se consulta antes de tocar servicios remotos. Es una
  // relación exacta por título normalizado y año aproximado; nunca sustituye
  // un MAL ya existente.
  const localTitles = [row.title, row.english_title, row.original_title, row.japanese_title]
    .filter(Boolean)
    .flatMap((value) => [String(value), providerNoiseVariant(value)]);
  const local = await findLocalAnimeIdentity(localTitles, reliableAnimeYear(row.year));
  if (local && (local.malId || local.anilistId)) {
    if (row.mal_id && local.malId && row.mal_id !== local.malId) {
      if (args().apply && !row.anilist_id && local.anilistId) {
        await prisma.show.update({ where: { id: row.id }, data: { anilist_id: local.anilistId } });
      }
      return { showId: row.id, title: row.title, status: "conflict", reason: `local_mal_conflict:${row.malId}` };
    }
    const existingMal = local.malId
      ? await prisma.show.findUnique({ where: { mal_id: local.malId }, select: { id: true } })
      : null;
    // MAL es único en Show. Si ya lo usa otra ficha exacta, no podemos
    // copiarlo por la restricción de la columna, pero sí podemos heredar sus
    // cruces TMDB/AniList cuando no hay valores contradictorios. Esto repara
    // duplicados importados por proveedores distintos sin mover episodios.
    const malLinkedRows = local.malId
      ? await prisma.show.findMany({
        where: { mal_id: local.malId, id: { not: row.id } },
        select: { tmdb_id: true, anilist_id: true },
      })
      : [];
    const malLinkedTmdbIds = [...new Set(malLinkedRows
      .map((item) => item.tmdb_id)
      .filter((value): value is number => Number.isInteger(value) && value > 0))];
    const malLinkedAniListIds = [...new Set(malLinkedRows
      .map((item) => item.anilist_id)
      .filter((value): value is string => Boolean(value)))];
    const inheritedTmdbId = malLinkedTmdbIds.length === 1 ? malLinkedTmdbIds[0] : null;
    const inheritedAniListId = malLinkedAniListIds.length === 1 ? malLinkedAniListIds[0] : null;
    const safeMalId = local.malId && (!existingMal || existingMal.id === row.id) ? local.malId : null;
    const safeAniListId = !row.anilist_id ? local.anilistId || inheritedAniListId : null;
    const safeTmdbId = !row.tmdb_id ? inheritedTmdbId : null;
    const result: Result = {
      showId: row.id,
      title: row.title,
      matchedTitle: local.canonicalTitle,
      ...(safeAniListId ? { anilistId: safeAniListId } : {}),
      ...(safeMalId ? { malId: safeMalId } : {}),
      ...(safeTmdbId ? { tmdbId: safeTmdbId } : {}),
      score: 1,
      status: safeMalId || safeAniListId || safeTmdbId ? "updated" : "conflict",
      reason: safeMalId || safeAniListId || safeTmdbId
        ? (existingMal ? "inherited_from_exact_mal_identity" : "local_index_exact")
        : "local_mal_already_used",
    };
    if (args().apply) {
      await prisma.show.update({
        where: { id: row.id },
        data: {
          ...(safeTmdbId ? { tmdb_id: safeTmdbId } : {}),
          ...(row.mal_id || !safeMalId ? {} : { mal_id: safeMalId }),
          ...(row.anilist_id || !safeAniListId ? {} : { anilist_id: safeAniListId }),
        },
      });
    }
    return result;
  }
  // A TMDB→Wikidata edge is an exact cross-reference. Prefer it over any
  // title search so localized legacy rows can be repaired without guessing a
  // franchise or sequel from a fuzzy result.
  const wikidata = await fetchWikidataIdentity(Number(row.tmdb_id));
  if (wikidata?.malId) {
    const enrichedAniList = wikidata.anilistId || (!row.anilist_id
      ? (await fetchWikidataByMal(wikidata.malId))?.anilistId || null
      : null);
    if (row.mal_id && row.mal_id !== wikidata.malId) {
      // Keep the existing MAL value, but an exact TMDB→AniList edge is still
      // safe to persist when the row is missing AniList.
      if (args().apply && !row.anilist_id && enrichedAniList) {
        await prisma.show.update({ where: { id: row.id }, data: { anilist_id: enrichedAniList } });
      }
      return {
        showId: row.id,
        title: row.title,
        ...(enrichedAniList ? { anilistId: enrichedAniList } : {}),
        status: "conflict",
        reason: `existing_mal:${row.mal_id}`,
      };
    }
    const result: Result = {
      showId: row.id,
      title: row.title,
      matchedTitle: row.title,
      malId: wikidata.malId,
      ...(enrichedAniList ? { anilistId: enrichedAniList } : {}),
      score: 1,
      status: "updated",
      reason: "exact_tmdb_wikidata",
    };
    if (args().apply) {
      try {
        await prisma.show.update({
          where: { id: row.id },
          data: {
            mal_id: wikidata.malId,
            ...(row.anilist_id || !enrichedAniList ? {} : { anilist_id: enrichedAniList }),
          },
        });
      } catch (error: any) {
        if (error?.code === "P2002") {
          // A duplicate MAL can be a second imported row for the same work.
          // Keep the unique MAL untouched, but retain the independent AniList
          // cross-reference when it is still missing on this row.
          if (!row.anilist_id && enrichedAniList) {
            await prisma.show.update({ where: { id: row.id }, data: { anilist_id: enrichedAniList } });
            return { ...result, status: "updated", reason: "anilist_only_mal_conflict" };
          }
          return { ...result, status: "conflict", reason: "mal_id_already_used" };
        }
        throw error;
      }
    }
    return result;
  }
  const aliases = [row.title, row.english_title, row.original_title, row.japanese_title]
    .map((value) => String(value || "").trim())
    .filter((value, index, values) => value && values.findIndex((item) => clean(item) === clean(value)) === index)
    .slice(0, 4);
  if (!aliases.length) return { showId: row.id, title: row.title, status: "unresolved", reason: "no_title" };

  let best: { candidate: AnimeCandidate; score: number; matchedTitle: string } | null = null;
  for (const alias of aliases) {
    const queries = [...new Set([alias, clean(alias)].filter((query) => query.length >= 2))];
    for (const query of queries) {
      let candidate: AnimeCandidate | null = null;
      try { candidate = await searchAniList(query); } catch { candidate = null; }
      if (!candidate || !candidate.idMal) {
        try { candidate = await searchKitsu(query); } catch { candidate = null; }
      }
      if (!candidate || !candidate.idMal) {
        try { candidate = await searchJikan(query); } catch { candidate = null; }
      }
      if (!candidate) continue;
      const titles = candidateTitles(candidate);
      const titleScore = Math.max(...titles.map((title) => similarity(alias, title)), 0);
      const exact = titles.some((title) => clean(title) === clean(alias));
      const rowYear = reliableAnimeYear(row.year);
      const yearDelta = rowYear && candidate.startDate?.year ? Math.abs(rowYear - Number(candidate.startDate.year)) : 0;
      // A sequel with a shared franchise title is not a safe identity match.
      // When both sides have a year, reject gaps larger than two years instead of
      // allowing a high token overlap to attach the wrong MAL ID.
      if (rowYear && candidate.startDate?.year && yearDelta > 2) continue;
      const yearBonus = yearDelta === 0 ? 0.08 : yearDelta === 1 ? 0.03 : yearDelta > 2 ? -0.12 : 0;
      const score = Math.max(0, Math.min(1, titleScore + (exact ? 0.22 : 0) + yearBonus));
      const matchedTitle = titles.sort((a, b) => similarity(alias, b) - similarity(alias, a))[0] || alias;
      if (!best || score > best.score) best = { candidate, score, matchedTitle };
      if (exact && yearDelta <= 1) break;
    }
    if (best?.score && best.score >= 0.98) break;
  }

  const strongKitsuMatch = Boolean(
    best?.candidate.kitsuId &&
    best.candidate.externalMatch &&
    best.score >= 0.45 &&
    (!row.year || !best.candidate.startDate?.year || Math.abs(row.year - Number(best.candidate.startDate.year)) <= 1),
  );
  if (!best || (!strongKitsuMatch && best.score < 0.76) || !best.candidate.idMal) {
    return { showId: row.id, title: row.title, status: "unresolved", score: best?.score, reason: !best ? "no_match" : !best.candidate.idMal ? "missing_mal" : "low_confidence" };
  }
  // AniList search returns its own numeric id. Kitsu's primary id is not an
  // AniList id; only use the explicit mapping when the fallback provider was
  // used, otherwise we would persist a Kitsu id in the anilist_id column.
  const anilistId = best.candidate.anilistId || (!best.candidate.kitsuId && best.candidate.id > 0 ? String(best.candidate.id) : null);
  const malId = Number(best.candidate.idMal);
  if (!Number.isInteger(malId) || malId <= 0) return { showId: row.id, title: row.title, status: "unresolved", reason: "invalid_mal" };
  if (row.mal_id && row.mal_id !== malId) return { showId: row.id, title: row.title, status: "conflict", reason: `existing_mal:${row.mal_id}` };

  const result: Result = { showId: row.id, title: row.title, matchedTitle: best.matchedTitle, ...(anilistId ? { anilistId } : {}), malId, score: best.score, status: "updated" };
  if (args().apply) {
    try {
      await prisma.show.update({
        where: { id: row.id },
        data: {
          mal_id: malId,
          ...(row.anilist_id || !anilistId ? {} : { anilist_id: anilistId }),
          english_title: row.english_title || best.candidate.title?.english || undefined,
          japanese_title: row.japanese_title || best.candidate.title?.native || undefined,
        },
      });
    } catch (error: any) {
      if (error?.code === "P2002") {
        if (!row.anilist_id && anilistId) {
          await prisma.show.update({ where: { id: row.id }, data: { anilist_id: anilistId } });
          return { ...result, status: "updated", reason: "anilist_only_mal_conflict" };
        }
        return { ...result, status: "conflict", reason: "mal_id_already_used" };
      }
      throw error;
    }
  }
  return result;
}

async function main() {
  const options = args();
  const rows = await prisma.show.findMany({
    where: {
      category: "anime",
      ...(options.primaryOnly ? { source: { in: PRIMARY_SOURCES } } : {}),
      ...(options.onlyNone
        ? { tmdb_id: null, mal_id: null, anilist_id: null }
        : { OR: [{ mal_id: null }, { anilist_id: null }] }),
      ...(options.afterId ? { id: { gt: options.afterId } } : {}),
    },
    orderBy: { id: "asc" },
    take: options.limit,
    select: { id: true, title: true, original_title: true, english_title: true, japanese_title: true, normalized_title: true, base_normalized_title: true, year: true, tmdb_id: true, mal_id: true, anilist_id: true },
  });
  const results: Result[] = [];
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= rows.length) return;
      const row = rows[index];
      try { results[index] = await resolve(row); } catch (error) {
        results[index] = { showId: row.id, title: row.title, status: "unresolved", reason: error instanceof Error ? error.message : String(error) };
      }
      await sleep(options.delayMs);
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.concurrency, rows.length) }, () => worker()));
  const summary = {
    dry_run: !options.apply,
    considered: rows.length,
    updated: results.filter((row) => row?.status === "updated").length,
    unresolved: results.filter((row) => row?.status === "unresolved").length,
    conflicts: results.filter((row) => row?.status === "conflict").length,
    next_after_id: rows.length > 0 ? rows[rows.length - 1].id : null,
    results,
  };
  if (options.report) {
    const fs = await import("node:fs/promises");
    await fs.writeFile(options.report, JSON.stringify(summary, null, 2), "utf8");
  }
  console.log(JSON.stringify({ ...summary, results: undefined }, null, 2));
}

main().finally(() => prisma.$disconnect());
