import { prisma } from "./db";
import { normalizeTitleKey } from "./utils/titleNormalizer";

export type LocalAnimeIdentity = {
  canonicalTitle: string;
  aliases: string[];
  malId: number | null;
  anilistId: string | null;
  kitsuId: string | null;
  anidbId: string | null;
  year: number | null;
};

function exactTitleKeys(titles: string[]): string[] {
  const keys = new Set<string>();
  for (const title of titles) {
    const raw = String(title || "").trim();
    if (!raw) continue;
    const normalized = normalizeTitleKey(raw);
    if (normalized) keys.add(normalized);

    // Algunos proveedores escriben una temporada como "S2" o "Season 2",
    // mientras que el índice oficial la publica como "2". Solo generamos esta
    // equivalencia cuando el número está explícitamente marcado como temporada;
    // nunca quitamos números sueltos, porque podrían identificar una película,
    // OVA o secuela diferente.
    if (/\b(?:s|season|temporada)\s*\d{1,2}\b/i.test(raw)) {
      const seasonAsNumber = raw.replace(/\b(?:s|season|temporada)\s*(\d{1,2})\b/gi, " $1");
      const seasonKey = normalizeTitleKey(seasonAsNumber);
      if (seasonKey) keys.add(seasonKey);
      const seasonBase = raw.replace(/\b(?:s|season|temporada)\s*\d{1,2}\b/gi, " ");
      const seasonBaseKey = normalizeTitleKey(seasonBase);
      if (seasonBaseKey) keys.add(seasonBaseKey);
    }
  }
  return [...keys];
}

function requestedSeason(titles: string[]): number | null {
  const markers = titles.flatMap((title) => [...String(title || "").matchAll(/\b(?:s|season|temporada)\s*(\d{1,2})\b/gi)].map((match) => Number(match[1])));
  const unique = [...new Set(markers)];
  return unique.length === 1 && Number.isInteger(unique[0]) ? unique[0] : null;
}

function hasAmbiguousSeasons(titles: string[]): boolean {
  const markers = titles.flatMap((title) => [...String(title || "").matchAll(/\b(?:s|season|temporada)\s*(\d{1,2})\b/gi)].map((match) => Number(match[1])));
  return new Set(markers).size > 1;
}

function seasonSpecificRows<T extends { canonical_title: string; aliases: string }>(rows: T[], season: number | null): T[] {
  if (!season) return rows;
  const marker = new RegExp(`\\b(?:${season}(?:st|nd|rd|th)?|season\\s*${season}|temporada\\s*${season})\\b`, "i");
  const otherSeason = /\b(?:[2-9]|10|11|12)(?:st|nd|rd|th)?\s+season\b|\bseason\s*(?:[2-9]|10|11|12)\b|\btemporada\s*(?:[2-9]|10|11|12)\b/i;
  const annotated = rows.filter((row) => marker.test(`${row.canonical_title} ${row.aliases}`));
  if (annotated.length) return annotated;
  // The official index often stores season one under the franchise title and
  // omits the literal "Season 1" marker. It is safe to use that fallback only
  // when there are no later-season markers in the candidate row.
  if (season === 1) {
    const special = /\b(?:specials?|ova|ona|recap|movie|picture\s+drama|twi[- ]yaba)\b/i;
    return rows.filter((row) => {
      const text = `${row.canonical_title} ${row.aliases}`;
      return !otherSeason.test(text) && !special.test(text);
    });
  }
  return [];
}

/** Busca solo en el índice local; nunca realiza una petición HTTP. */
export async function findLocalAnimeIdentity(titles: string[], year?: number | null): Promise<LocalAnimeIdentity | null> {
  if (hasAmbiguousSeasons(titles)) return null;
  const keys = exactTitleKeys(titles);
  if (!keys.length) return null;
  const rows = await prisma.localCatalogIndex.findMany({
    where: { kind: "anime", normalized_title: { in: keys } },
  });
  const usable = seasonSpecificRows(rows, requestedSeason(titles)).filter((row) => row.mal_id || row.anilist_id);
  if (!usable.length) return null;

  const knownYearRows = year
    ? usable.filter((row) => row.year && Math.abs(year - row.year) <= 1)
    : [];
  const yearScoped = knownYearRows.length ? knownYearRows : usable;
  const malIds = new Set(yearScoped.map((row) => row.mal_id).filter((id): id is number => Number.isInteger(id) && id > 0));
  const anilistIds = new Set(yearScoped.map((id) => id.anilist_id).filter((id): id is string => Boolean(id)));

  // Multiple IDs for the same normalized title are usually seasons, movies or
  // OVAs. Without a unique external identity, leaving the row unresolved is
  // safer than attaching playback/metadata to the wrong work.
  if (malIds.size > 1 || anilistIds.size > 1) return null;

  const row = yearScoped
    .slice()
    .sort((a, b) => {
      const aExact = keys.includes(a.normalized_title) ? 1 : 0;
      const bExact = keys.includes(b.normalized_title) ? 1 : 0;
      const aYear = year && a.year ? Math.abs(year - a.year) : 99;
      const bYear = year && b.year ? Math.abs(year - b.year) : 99;
      return bExact - aExact || aYear - bYear;
    })[0];
  return row ? {
    canonicalTitle: row.canonical_title,
    aliases: parseAliases(row.aliases),
    malId: row.mal_id,
    anilistId: row.anilist_id,
    kitsuId: row.kitsu_id,
    anidbId: row.anidb_id,
    year: row.year,
  } : null;
}

function parseAliases(value: string): string[] {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((alias): alias is string => typeof alias === "string" && alias.trim().length > 0)
      : [];
  } catch {
    return [];
  }
}
