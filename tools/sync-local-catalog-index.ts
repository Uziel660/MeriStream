#!/usr/bin/env node
/** Importa el índice de referencias anime en PostgreSQL sin exponerlo al cliente. */
import "dotenv/config";
import { prisma } from "../server/db";
import { normalizeTitleKey } from "../server/utils/titleNormalizer";

const RELEASES = "https://api.github.com/repos/manami-project/anime-offline-database/releases/latest";
const FALLBACK = "https://github.com/manami-project/anime-offline-database/releases/latest/download/anime-offline-database.jsonl";

type Entry = { title?: string; synonyms?: string[]; type?: string; animeSeason?: { year?: number }; sources?: string[] };
type IndexRow = {
  kind: string; canonical_title: string; normalized_title: string; aliases: string;
  tmdb_id: number | null; mal_id: number | null; anilist_id: string | null;
  kitsu_id: string | null; anidb_id: string | null; year: number | null; source: string;
};

function idFrom(sources: string[] | undefined, patterns: RegExp[]): string | null {
  for (const source of sources || []) for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

function toRows(entry: Entry): IndexRow[] {
  const title = String(entry.title || "").trim();
  if (!title) return [];
  const aliases = [title, ...(Array.isArray(entry.synonyms) ? entry.synonyms : [])]
    .map((value) => String(value || "").trim())
    .filter((value, index, values) => value && values.findIndex((item) => normalizeTitleKey(item) === normalizeTitleKey(value)) === index);
  const mal = idFrom(entry.sources, [/myanimelist\.net\/anime\/(\d+)/i]);
  const anilist = idFrom(entry.sources, [/anilist\.co\/anime\/(\d+)/i]);
  const kitsu = idFrom(entry.sources, [/kitsu(?:\.app|\.io)\/anime\/(\d+)/i]);
  const anidb = idFrom(entry.sources, [/anidb\.net\/anime\/(\d+)/i]);
  const common = {
    kind: "anime", canonical_title: title, aliases: JSON.stringify(aliases),
    tmdb_id: Number(idFrom(entry.sources, [/themoviedb\.org\/(?:movie|tv)\/(\d+)/i])) || null,
    mal_id: mal ? Number(mal) : null, anilist_id: anilist, kitsu_id: kitsu, anidb_id: anidb,
    year: Number(entry.animeSeason?.year) || null, source: "anime-offline-database",
  };
  return aliases.map((alias) => ({ ...common, normalized_title: normalizeTitleKey(alias) })).filter((row) => row.normalized_title);
}

async function datasetUrl(): Promise<string> {
  try {
    const response = await fetch(RELEASES, { headers: { accept: "application/vnd.github+json", "user-agent": "MeriStream-local-index" } });
    const release = await response.json() as any;
    const asset = release.assets?.find((item: any) => item.name === "anime-offline-database.jsonl");
    return asset?.browser_download_url || FALLBACK;
  } catch { return FALLBACK; }
}

async function main() {
  const url = process.env.LOCAL_ANIME_INDEX_URL || await datasetUrl();
  const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "MeriStream-local-index" } });
  if (!response.ok || !response.body) throw new Error(`No se pudo descargar el índice (${response.status})`);
  const text = await response.text();
  const rows: IndexRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { rows.push(...toRows(JSON.parse(line) as Entry)); } catch { /* ignora líneas corruptas */ }
  }
  const unique = [...new Map(rows.map((row) => [`${row.kind}:${row.normalized_title}:${row.mal_id || ""}:${row.anilist_id || ""}`, row])).values()];
  await prisma.localCatalogIndex.deleteMany({ where: { source: "anime-offline-database" } });
  for (let offset = 0; offset < unique.length; offset += 1000) {
    await prisma.localCatalogIndex.createMany({ data: unique.slice(offset, offset + 1000) });
  }
  console.log(JSON.stringify({ source: url, entries: unique.length }, null, 2));
}

main().finally(() => prisma.$disconnect());
