import { prisma } from "./db";

const VISIBILITY_ROW_ID = "default";

export interface CatalogVisibility {
  hiddenGenres: string[];
  hiddenShowIds: string[];
}

export interface CatalogGenreSummary {
  genre: string;
  count: number;
  hidden: boolean;
}

export interface AdminCatalogVisibility extends CatalogVisibility {
  genres: CatalogGenreSummary[];
  totalShows: number;
  hiddenShowCount: number;
}

export function normalizeVisibilityKey(value: unknown): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function listFromJson(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return listFromJson(parsed);
    } catch {
      return value.split(",").map((item) => item.trim()).filter(Boolean);
    }
  }
  return [];
}

function canonicalList(values: unknown[], normalize = false): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const raw = String(value || "").trim();
    if (!raw) continue;
    const key = normalize ? normalizeVisibilityKey(raw) : raw;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(normalize ? key : raw);
  }
  return result;
}

export function normalizeVisibility(input: Partial<CatalogVisibility> | null | undefined): CatalogVisibility {
  return {
    hiddenGenres: canonicalList(listFromJson(input?.hiddenGenres), true),
    hiddenShowIds: canonicalList(listFromJson(input?.hiddenShowIds)),
  };
}

export async function getCatalogVisibility(): Promise<CatalogVisibility> {
  // Use SQL here so a long-lived dev server can adopt this additive table
  // without requiring a Prisma engine restart while an import is running.
  const rows = await prisma.$queryRawUnsafe<Array<{ hidden_genres: string; hidden_show_ids: string }>>(
    'SELECT "hidden_genres", "hidden_show_ids" FROM "CatalogVisibility" WHERE "id" = $1 LIMIT 1',
    VISIBILITY_ROW_ID,
  );
  const row = rows[0];
  return normalizeVisibility({
    hiddenGenres: row?.hidden_genres,
    hiddenShowIds: row?.hidden_show_ids,
  });
}

export async function saveCatalogVisibility(input: Partial<CatalogVisibility>): Promise<CatalogVisibility> {
  const next = normalizeVisibility(input);
  await prisma.$executeRawUnsafe(
    `INSERT INTO "CatalogVisibility" ("id", "hidden_genres", "hidden_show_ids", "updated_at")
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT ("id") DO UPDATE SET
       "hidden_genres" = EXCLUDED."hidden_genres",
       "hidden_show_ids" = EXCLUDED."hidden_show_ids",
       "updated_at" = NOW()`,
    VISIBILITY_ROW_ID,
    JSON.stringify(next.hiddenGenres),
    JSON.stringify(next.hiddenShowIds),
  );
  return next;
}

export function genreValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).flatMap((item) => item.split(/[,/|•]+/));
  return String(value || "").split(/[,/|•]+/);
}

export function isGenreHidden(genre: unknown, visibility: CatalogVisibility): boolean {
  const key = normalizeVisibilityKey(genre);
  return Boolean(key && visibility.hiddenGenres.includes(key));
}

function categoryKey(item: any): string {
  const raw = String(item?.kind || item?.category || "series").toLowerCase();
  if (raw.includes("movie") || raw.includes("pel")) return "movie";
  if (raw.includes("anime")) return "anime";
  return "series";
}

export function catalogVisibilityKeys(item: any): string[] {
  const keys = [String(item?.id || "").trim()].filter(Boolean);
  const tmdbId = Number(item?.tmdb_id);
  if (Number.isInteger(tmdbId) && tmdbId > 0) {
    const kind = categoryKey(item);
    keys.push(`tmdb-${kind}-${tmdbId}`, `tmdb:${kind}:${tmdbId}`);
  }
  return keys;
}

export function isCatalogItemHidden(item: any, visibility: CatalogVisibility): boolean {
  const hiddenIds = new Set(visibility.hiddenShowIds);
  return catalogVisibilityKeys(item).some((key) => hiddenIds.has(key));
}

function identityKey(item: any): string {
  const tmdbId = Number(item?.tmdb_id);
  if (Number.isInteger(tmdbId) && tmdbId > 0) return `tmdb:${categoryKey(item)}:${tmdbId}`;
  return `${categoryKey(item)}:${normalizeVisibilityKey(item?.title)}`;
}

export async function getAdminCatalogVisibility(): Promise<AdminCatalogVisibility> {
  const [visibility, shows, mediaItems] = await Promise.all([
    getCatalogVisibility(),
    prisma.show.findMany({ select: { id: true, title: true, genres: true, category: true, tmdb_id: true } }),
    prisma.mediaItem.findMany({ select: { id: true, title: true, genres: true, kind: true, tmdb_id: true } }),
  ]);

  const works = new Map<string, any>();
  for (const item of [...shows, ...mediaItems]) {
    const key = identityKey(item);
    if (!works.has(key)) works.set(key, item);
  }

  const counts = new Map<string, { label: string; count: number }>();
  for (const item of works.values()) {
    const counted = new Set<string>();
    for (const value of genreValues(item.genres)) {
      const label = String(value || "").trim();
      const key = normalizeVisibilityKey(label);
      if (!key || counted.has(key)) continue;
      counted.add(key);
      const current = counts.get(key);
      if (current) current.count += 1;
      else counts.set(key, { label, count: 1 });
    }
  }

  const genres = [...counts.entries()]
    .map(([key, value]) => ({ genre: value.label, count: value.count, hidden: visibility.hiddenGenres.includes(key) }))
    .sort((a, b) => b.count - a.count || a.genre.localeCompare(b.genre, "es"));

  const hiddenWorkKeys = new Set(visibility.hiddenShowIds.map((value) => {
    const publicId = /^tmdb-(movie|series|anime)-(\d+)$/.exec(value);
    return publicId ? `tmdb:${publicId[1]}:${publicId[2]}` : value;
  }));
  return {
    ...visibility,
    genres,
    totalShows: works.size,
    hiddenShowCount: hiddenWorkKeys.size,
  };
}
