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

/** Busca solo en el índice local; nunca realiza una petición HTTP. */
export async function findLocalAnimeIdentity(titles: string[], year?: number | null): Promise<LocalAnimeIdentity | null> {
  const keys = [...new Set(titles.map((title) => normalizeTitleKey(title)).filter(Boolean))];
  if (!keys.length) return null;
  const rows = await prisma.localCatalogIndex.findMany({
    where: { kind: "anime", normalized_title: { in: keys } },
    take: 20,
  });
  const usable = rows
    .filter((row) => row.mal_id || row.anilist_id)
    .sort((a, b) => {
      const aExact = keys.includes(a.normalized_title) ? 1 : 0;
      const bExact = keys.includes(b.normalized_title) ? 1 : 0;
      const aYear = year && a.year ? Math.abs(year - a.year) : 99;
      const bYear = year && b.year ? Math.abs(year - b.year) : 99;
      return bExact - aExact || aYear - bYear;
    });
  const row = usable[0];
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
