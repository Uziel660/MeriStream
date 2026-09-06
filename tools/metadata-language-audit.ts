/**
 * Auditoría de metadatos ligera y de solo lectura.
 *
 * Recorre Show y MediaItem por cursor, sin hacer JOIN masivo ni cargar todo el
 * catálogo en memoria. Sirve para comprobar los invariantes de TMDB, idioma,
 * géneros y assets antes/después de una pasada de verificación.
 */
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../server/db";
import { isLikelyNonSpanishDescription } from "../server/metadataEngine";

type Counters = {
  total: number;
  tmdb: number;
  title: number;
  description: number;
  nonSpanishDescription: number;
  poster: number;
  backdrop: number;
  genres: number;
};

const emptyCounters = (): Counters => ({
  total: 0,
  tmdb: 0,
  title: 0,
  description: 0,
  nonSpanishDescription: 0,
  poster: 0,
  backdrop: 0,
  genres: 0,
});

const hasValue = (value: unknown): boolean => typeof value === "string" && value.trim().length > 0;

function countShow(row: any, counters: Counters): void {
  counters.total++;
  if (Number.isInteger(row.tmdb_id) && row.tmdb_id > 0) counters.tmdb++;
  if (hasValue(row.title)) counters.title++;
  if (hasValue(row.description) && String(row.description).trim().length >= 60) {
    counters.description++;
    if (isLikelyNonSpanishDescription(row.description)) counters.nonSpanishDescription++;
  }
  if (hasValue(row.poster_url) || hasValue(row.poster_path)) counters.poster++;
  if (hasValue(row.banner_url) || hasValue(row.backdrop_path)) counters.backdrop++;
  const genres = String(row.genres || "").trim().toLowerCase();
  if (genres && genres !== "multimedia") counters.genres++;
}

function countMedia(row: any, counters: Counters): void {
  counters.total++;
  if (Number.isInteger(row.tmdb_id) && row.tmdb_id > 0) counters.tmdb++;
  if (hasValue(row.title)) counters.title++;
  if (hasValue(row.poster_url) || hasValue(row.poster_path)) counters.poster++;
  if (hasValue(row.backdrop_path)) counters.backdrop++;
}

async function scanShows(): Promise<Counters> {
  const result = emptyCounters();
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.show.findMany({
      take: 1000,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
      select: { id: true, tmdb_id: true, title: true, description: true, poster_url: true, poster_path: true, banner_url: true, backdrop_path: true, genres: true },
    });
    if (rows.length === 0) break;
    for (const row of rows) countShow(row, result);
    cursor = rows[rows.length - 1].id;
    if (rows.length < 1000) break;
  }
  return result;
}

async function scanMediaItems(): Promise<Counters> {
  const result = emptyCounters();
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.mediaItem.findMany({
      take: 1000,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: "asc" },
      select: { id: true, tmdb_id: true, title: true, poster_url: true, poster_path: true, backdrop_path: true },
    });
    if (rows.length === 0) break;
    for (const row of rows) countMedia(row, result);
    cursor = rows[rows.length - 1].id;
    if (rows.length < 1000) break;
  }
  return result;
}

function pct(value: number, total: number): number {
  return total > 0 ? Math.round((value / total) * 10000) / 100 : 0;
}

async function main(): Promise<void> {
  const [shows, mediaItems] = await Promise.all([scanShows(), scanMediaItems()]);
  const report = {
    generated_at: new Date().toISOString(),
    read_only: true,
    shows: { ...shows, coverage: { tmdb_pct: pct(shows.tmdb, shows.total), descriptions_pct: pct(shows.description, shows.total), spanish_description_pct: pct(shows.description - shows.nonSpanishDescription, shows.description), poster_pct: pct(shows.poster, shows.total), backdrop_pct: pct(shows.backdrop, shows.total), genres_pct: pct(shows.genres, shows.total) } },
    media_items: { ...mediaItems, coverage: { tmdb_pct: pct(mediaItems.tmdb, mediaItems.total), poster_pct: pct(mediaItems.poster, mediaItems.total), backdrop_pct: pct(mediaItems.backdrop, mediaItems.total) } },
    note: "La detección de idioma es heurística y conservadora; no sustituye revisión humana de nombres propios.",
  };

  const outputDir = path.join(process.cwd(), "docs", "workstreams");
  fs.mkdirSync(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(outputDir, `metadata_language_audit_${stamp}.json`);
  const mdPath = path.join(outputDir, `metadata_language_audit_${stamp}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf-8");
  const lines = [
    "# Auditoría de metadatos e idioma",
    `Generado: ${report.generated_at}`,
    "",
    "## Show (ficha histórica)",
    `- Total: ${shows.total}`,
    `- TMDB: ${shows.tmdb} (${report.shows.coverage.tmdb_pct}%)`,
    `- Descripción sustantiva: ${shows.description} (${report.shows.coverage.descriptions_pct}%)`,
    `- Descripciones probablemente no españolas: ${shows.nonSpanishDescription}`,
    `- Poster: ${shows.poster} (${report.shows.coverage.poster_pct}%)`,
    `- Backdrop/banner: ${shows.backdrop} (${report.shows.coverage.backdrop_pct}%)`,
    `- Géneros no genéricos: ${shows.genres} (${report.shows.coverage.genres_pct}%)`,
    "",
    "## MediaItem (grafo canónico)",
    `- Total: ${mediaItems.total}`,
    `- TMDB: ${mediaItems.tmdb} (${report.media_items.coverage.tmdb_pct}%)`,
    `- Poster: ${mediaItems.poster} (${report.media_items.coverage.poster_pct}%)`,
    `- Backdrop: ${mediaItems.backdrop} (${report.media_items.coverage.backdrop_pct}%)`,
    "",
    report.note,
    "",
  ];
  fs.writeFileSync(mdPath, lines.join("\n"), "utf-8");
  console.log(JSON.stringify({ ...report, files: { json: jsonPath, markdown: mdPath } }, null, 2));
}

main().catch((error) => {
  console.error(`[metadata-language-audit] fatal: ${String((error as Error)?.message || error)}`);
  process.exitCode = 1;
}).finally(async () => prisma.$disconnect());

