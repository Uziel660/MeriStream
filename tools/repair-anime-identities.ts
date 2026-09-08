#!/usr/bin/env node
/**
 * Completa MAL/AniList para los anime legacy sin sobrescribir identidades
 * existentes. La consulta usa varios títulos y una puntuación conservadora;
 * una coincidencia dudosa se informa como pendiente en vez de inventar un ID.
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

type AnimeCandidate = {
  id: number;
  anilistId?: string | null;
  idMal?: number | null;
  title?: { romaji?: string | null; english?: string | null; native?: string | null; en_us?: string | null } | null;
  synonyms?: string[] | null;
  startDate?: { year?: number | null } | null;
  kitsuId?: string | null;
};

type Result = {
  showId: string;
  title: string;
  matchedTitle?: string;
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
    limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : undefined,
    concurrency: Math.min(6, Math.max(1, Number.isFinite(concurrency) ? Math.floor(concurrency) : 3)),
    delayMs: Math.max(250, Number(value("--delay-ms") || 600)),
    report: value("--report"),
    afterId: value("--after-id"),
  };
}

function clean(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(?:season|temporada|part|cour|cour\s+\d+|s\s*\d+)\s*\d*\b/gi, " ")
    .replace(/\b(?:tv|movie|film|ova|ona|special|recap)\b/gi, " ")
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
  const response = await fetch(searchUrl, { headers: { accept: "application/vnd.api+json", "user-agent": "MeriStream/1.0" }, signal: AbortSignal.timeout(4_000) });
  if (!response.ok) return null;
  const payload = await response.json() as any;
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  let best: AnimeCandidate | null = null;
  let bestScore = 0;
  for (const row of rows) {
    const attributes = row?.attributes || {};
    const titles = [attributes.canonicalTitle, attributes.titles?.canonical, ...Object.values(attributes.titles || {}), attributes.slug]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
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
      };
    }
  }
  if (!best?.kitsuId) return null;
  const mappingsResponse = await fetch(`https://kitsu.io/api/edge/anime/${encodeURIComponent(best.kitsuId)}/mappings`, { headers: { accept: "application/vnd.api+json", "user-agent": "MeriStream/1.0" }, signal: AbortSignal.timeout(4_000) });
  if (mappingsResponse.ok) {
    const mappings = (await mappingsResponse.json() as any)?.data;
    if (Array.isArray(mappings)) {
      const mal = mappings.find((entry: any) => entry?.attributes?.externalSite === "myanimelist/anime")?.attributes?.externalId;
      const anilist = mappings.find((entry: any) => entry?.attributes?.externalSite === "anilist/anime")?.attributes?.externalId;
      best.idMal = /^\d+$/.test(String(mal || "")) ? Number(mal) : null;
      if (anilist && /^\d+$/.test(String(anilist))) best.anilistId = String(anilist);
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
        if (error?.code === "P2002") return { ...result, status: "conflict", reason: "mal_id_already_used" };
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
    let candidate: AnimeCandidate | null = null;
    try { candidate = await searchAniList(alias); } catch { candidate = null; }
    if (!candidate) {
      try { candidate = await searchKitsu(alias); } catch { candidate = null; }
    }
    if (!candidate) continue;
    const titles = candidateTitles(candidate);
    const titleScore = Math.max(...titles.map((title) => similarity(alias, title)), 0);
    const exact = titles.some((title) => clean(title) === clean(alias));
    const yearDelta = row.year && candidate.startDate?.year ? Math.abs(Number(row.year) - Number(candidate.startDate.year)) : 0;
    // A sequel with a shared franchise title is not a safe identity match.
    // When both sides have a year, reject gaps larger than two years instead of
    // allowing a high token overlap to attach the wrong MAL ID.
    if (row.year && candidate.startDate?.year && yearDelta > 2) continue;
    const yearBonus = yearDelta === 0 ? 0.08 : yearDelta === 1 ? 0.03 : yearDelta > 2 ? -0.12 : 0;
    const score = Math.max(0, Math.min(1, titleScore + (exact ? 0.22 : 0) + yearBonus));
    const matchedTitle = titles.sort((a, b) => similarity(alias, b) - similarity(alias, a))[0] || alias;
    if (!best || score > best.score) best = { candidate, score, matchedTitle };
    if (exact && yearDelta <= 1) break;
  }

  if (!best || best.score < 0.76 || !best.candidate.idMal) {
    return { showId: row.id, title: row.title, status: "unresolved", score: best?.score, reason: !best ? "no_match" : !best.candidate.idMal ? "missing_mal" : "low_confidence" };
  }
  // AniList search returns its own numeric id. Kitsu's primary id is not an
  // AniList id; only use the explicit mapping when the fallback provider was
  // used, otherwise we would persist a Kitsu id in the anilist_id column.
  const anilistId = best.candidate.anilistId || (best.candidate.id > 0 ? String(best.candidate.id) : null);
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
      if (error?.code === "P2002") return { ...result, status: "conflict", reason: "mal_id_already_used" };
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
      OR: [{ mal_id: null }, { anilist_id: null }],
      ...(options.afterId ? { id: { gt: options.afterId } } : {}),
    },
    orderBy: { id: "asc" },
    take: options.limit,
    select: { id: true, title: true, original_title: true, english_title: true, japanese_title: true, year: true, tmdb_id: true, mal_id: true, anilist_id: true },
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
