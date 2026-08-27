import { PrismaClient } from "@prisma/client";
import { writeFileSync } from "fs";
import { join } from "path";

const p = new PrismaClient();

/**
 * Normaliza un título igual que titleNormalizer.normalizeTitleKey:
 * minúsculas, sin acentos, solo [a-z0-9].
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/** Mismos NOISE_TOKENS que titleNormalizer */
const NOISE_TOKENS = new Set([
  "ver", "veronline", "online", "gratis", "completa", "completo", "pelicula",
  "peliculas", "serie", "series", "capitulo", "episodio", "temporada",
  "latino", "latinos", "castellano", "espanol", "espanol", "spanish",
  "subtitulado", "subtitulada", "sub", "subs", "vod",
  "hd", "hq", "hdr", "4k", "uhd", "fhd", "fullhd", "bluray", "brrip",
  "dvdrip", "webrip", "webdl", "x264", "x265", "hevc", "h264",
  "1080p", "720p", "480p", "2160p", "1080", "720", "480", "2160",
  "mega", "cuevana", "cinecalidad", "animeflv", "tioanime", "jkanime",
  "latanime", "zonaleros", "danime", "monoschinos", "animeyabu",
  "descargar", "descarga", "download", "estreno", "estrenos", "audio",
]);

const SEASON_NOISE_RE =
  /(?:temporada|season|tp\d+|s\d{1,2}|\bpart\s*\d+|\bpart\s+(?:ii|iii|iv|v|vi|vii|viii|ix|xi|xii)|(?:\d+)(?:st|nd|rd|th)\s+season|\bfinal\s+season)/i;

const TITLE_NOISE_RE =
  /(?:latino|español|castellano|sub\s*español|subtitulad[oa]|sub|hd|full\s*hd|4k|ver\s+online|online|gratis|completa?|mega|cuevana|cinecalidad|animeflv|tioanime|descargar|descarga|audio|bluray|web\s*(?:dl|rip))/i;

interface DuplicateGroup {
  category: string;
  description: string;
  severity: "high" | "medium" | "low";
  groups: Array<{
    key: string;
    shows: Array<{
      id: string;
      title: string;
      normalized_title: string;
      base_normalized_title: string | null;
      category: string;
      year: number;
      tmdb_id: number | null;
      mal_id: number | null;
      episode_count: number;
      source: string;
      created_at: string;
    }>;
  }>;
}

interface TitleNoiseEntry {
  id: string;
  title: string;
  category: string;
  year: number;
  noise_tokens_found: string[];
  normalized_title: string;
  episode_count: number;
}

interface Report {
  generated_at: string;
  total_shows: number;
  total_episodes: number;
  total_media_items: number;
  sections: {
    exact_title_duplicates: DuplicateGroup;
    normalized_title_duplicates: DuplicateGroup;
    base_normalized_duplicates: DuplicateGroup;
    same_tmdb_id: DuplicateGroup;
    same_mal_id: DuplicateGroup;
    season_split_detection: DuplicateGroup;
    sequel_detection: DuplicateGroup;
    cross_platform_duplicates: DuplicateGroup;
    mediaitem_duplicates: DuplicateGroup;
    title_noise_analysis: {
      category: string;
      description: string;
      severity: "high" | "medium" | "low";
      total_noisy: number;
      top_noise_tokens: Array<{ token: string; count: number }>;
      entries: TitleNoiseEntry[];
    };
  };
  summary: {
    total_duplicate_groups: number;
    total_duplicate_shows: number;
    severity_high: number;
    severity_medium: number;
    severity_low: number;
  };
}

(async () => {
  await p.$connect();

  const [totalShows, totalEps, totalMI] = await Promise.all([
    p.show.count(),
    p.episode.count(),
    p.mediaItem.count(),
  ]);

  console.log(`\n=== DEEP DUPLICATE AUDIT ===`);
  console.log(`Shows: ${totalShows} | Episodes: ${totalEps} | MediaItems: ${totalMI}\n`);

  const allGroups: DuplicateGroup[] = [];
  const allNoise: TitleNoiseEntry[] = [];

  // ──────────────────────────────────────────────────────────────────
  // 1. EXACT TITLE DUPLICATES (case-insensitive)
  // ──────────────────────────────────────────────────────────────────
  console.log("1/8 Exact title duplicates...");
  const exactDups = await p.$queryRawUnsafe(`
    SELECT LOWER(TRIM(title)) AS norm_title, COUNT(*)::int AS cnt,
           ARRAY_AGG(id ORDER BY created_at) AS ids
    FROM "Show"
    GROUP BY LOWER(TRIM(title))
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
  `) as any[];

  const exactGroup: DuplicateGroup = {
    category: "exact_title_duplicates",
    description: "Shows with identical title (case-insensitive). Most likely true duplicates.",
    severity: "high",
    groups: [],
  };
  for (const row of exactDups) {
    const ids: string[] = row.ids;
    const shows = await p.show.findMany({
      where: { id: { in: ids } },
      include: { _count: { select: { episodes: true } } },
    });
    exactGroup.groups.push({
      key: row.norm_title,
      shows: shows.map((s) => ({
        id: s.id, title: s.title, normalized_title: s.normalized_title,
        base_normalized_title: s.base_normalized_title, category: s.category,
        year: s.year, tmdb_id: s.tmdb_id, mal_id: s.mal_id,
        episode_count: s._count.episodes, source: s.source,
        created_at: s.created_at.toISOString(),
      })),
    });
  }
  allGroups.push(exactGroup);
  console.log(`  Found ${exactDups.length} groups`);

  // ──────────────────────────────────────────────────────────────────
  // 2. NORMALIZED TITLE DUPLICATES
  // ──────────────────────────────────────────────────────────────────
  console.log("2/8 Normalized title duplicates...");
  const normDups = await p.$queryRawUnsafe(`
    SELECT normalized_title, COUNT(*)::int AS cnt,
           ARRAY_AGG(id ORDER BY created_at) AS ids
    FROM "Show"
    WHERE normalized_title IS NOT NULL AND normalized_title != ''
    GROUP BY normalized_title
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
  `) as any[];

  const normGroup: DuplicateGroup = {
    category: "normalized_title_duplicates",
    description: "Shows sharing the same normalized_title. May differ in season suffix or source.",
    severity: "high",
    groups: [],
  };
  for (const row of normDups) {
    const ids: string[] = row.ids;
    const shows = await p.show.findMany({
      where: { id: { in: ids } },
      include: { _count: { select: { episodes: true } } },
    });
    normGroup.groups.push({
      key: row.normalized_title,
      shows: shows.map((s) => ({
        id: s.id, title: s.title, normalized_title: s.normalized_title,
        base_normalized_title: s.base_normalized_title, category: s.category,
        year: s.year, tmdb_id: s.tmdb_id, mal_id: s.mal_id,
        episode_count: s._count.episodes, source: s.source,
        created_at: s.created_at.toISOString(),
      })),
    });
  }
  allGroups.push(normGroup);
  console.log(`  Found ${normDups.length} groups`);

  // ──────────────────────────────────────────────────────────────────
  // 3. BASE NORMALIZED TITLE DUPLICATES
  // ──────────────────────────────────────────────────────────────────
  console.log("3/8 Base normalized title duplicates...");
  const baseNormDups = await p.$queryRawUnsafe(`
    SELECT base_normalized_title, COUNT(*)::int AS cnt,
           ARRAY_AGG(id ORDER BY created_at) AS ids
    FROM "Show"
    WHERE base_normalized_title IS NOT NULL AND base_normalized_title != ''
      AND base_normalized_title != normalized_title
    GROUP BY base_normalized_title
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
  `) as any[];

  const baseNormGroup: DuplicateGroup = {
    category: "base_normalized_duplicates",
    description: "Shows sharing the same base_normalized_title but different normalized_titles (likely season splits).",
    severity: "medium",
    groups: [],
  };
  for (const row of baseNormDups) {
    const ids: string[] = row.ids;
    const shows = await p.show.findMany({
      where: { id: { in: ids } },
      include: { _count: { select: { episodes: true } } },
    });
    baseNormGroup.groups.push({
      key: row.base_normalized_title,
      shows: shows.map((s) => ({
        id: s.id, title: s.title, normalized_title: s.normalized_title,
        base_normalized_title: s.base_normalized_title, category: s.category,
        year: s.year, tmdb_id: s.tmdb_id, mal_id: s.mal_id,
        episode_count: s._count.episodes, source: s.source,
        created_at: s.created_at.toISOString(),
      })),
    });
  }
  allGroups.push(baseNormGroup);
  console.log(`  Found ${baseNormDups.length} groups`);

  // ──────────────────────────────────────────────────────────────────
  // 4. SAME TMDB ID
  // ──────────────────────────────────────────────────────────────────
  console.log("4/8 Same TMDB ID...");
  const tmdbDups = await p.$queryRawUnsafe(`
    SELECT tmdb_id, COUNT(*)::int AS cnt,
           ARRAY_AGG(id ORDER BY created_at) AS ids
    FROM "Show"
    WHERE tmdb_id IS NOT NULL
    GROUP BY tmdb_id
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
  `) as any[];

  const tmdbGroup: DuplicateGroup = {
    category: "same_tmdb_id",
    description: "Different shows sharing the same TMDB ID. These should be merged.",
    severity: "high",
    groups: [],
  };
  for (const row of tmdbDups) {
    const ids: string[] = row.ids;
    const shows = await p.show.findMany({
      where: { id: { in: ids } },
      include: { _count: { select: { episodes: true } } },
    });
    tmdbGroup.groups.push({
      key: String(row.tmdb_id),
      shows: shows.map((s) => ({
        id: s.id, title: s.title, normalized_title: s.normalized_title,
        base_normalized_title: s.base_normalized_title, category: s.category,
        year: s.year, tmdb_id: s.tmdb_id, mal_id: s.mal_id,
        episode_count: s._count.episodes, source: s.source,
        created_at: s.created_at.toISOString(),
      })),
    });
  }
  allGroups.push(tmdbGroup);
  console.log(`  Found ${tmdbDups.length} groups`);

  // ──────────────────────────────────────────────────────────────────
  // 5. SAME MAL ID
  // ──────────────────────────────────────────────────────────────────
  console.log("5/8 Same MAL ID...");
  const malDups = await p.$queryRawUnsafe(`
    SELECT mal_id, COUNT(*)::int AS cnt,
           ARRAY_AGG(id ORDER BY created_at) AS ids
    FROM "Show"
    WHERE mal_id IS NOT NULL
    GROUP BY mal_id
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
  `) as any[];

  const malGroup: DuplicateGroup = {
    category: "same_mal_id",
    description: "Different shows sharing the same MAL ID. These should be merged.",
    severity: "high",
    groups: [],
  };
  for (const row of malDups) {
    const ids: string[] = row.ids;
    const shows = await p.show.findMany({
      where: { id: { in: ids } },
      include: { _count: { select: { episodes: true } } },
    });
    malGroup.groups.push({
      key: String(row.mal_id),
      shows: shows.map((s) => ({
        id: s.id, title: s.title, normalized_title: s.normalized_title,
        base_normalized_title: s.base_normalized_title, category: s.category,
        year: s.year, tmdb_id: s.tmdb_id, mal_id: s.mal_id,
        episode_count: s._count.episodes, source: s.source,
        created_at: s.created_at.toISOString(),
      })),
    });
  }
  allGroups.push(malGroup);
  console.log(`  Found ${malDups.length} groups`);

  // ──────────────────────────────────────────────────────────────────
  // 6. SEASON SPLIT DETECTION
  // ──────────────────────────────────────────────────────────────────
  console.log("6/8 Season split detection...");
  const allShowsForSeason = await p.$queryRawUnsafe(`
    SELECT id, title, normalized_title, base_normalized_title, category, year,
           tmdb_id, mal_id, source, created_at
    FROM "Show"
    ORDER BY title
  `) as any[];

  // Build base title map: strip season markers, group by slugified base
  const seasonMap = new Map<string, any[]>();
  for (const show of allShowsForSeason) {
    // Strip season markers: "Temporada 2", "TP2", "Season 3", "S02", "Part 2" etc.
    let stripped = show.title
      .replace(/\btemporada\s*\d+/gi, "")
      .replace(/\btp\d+\b/gi, "")
      .replace(/\bseason\s*\d+/gi, "")
      .replace(/\bs\d{1,2}\b/gi, "")
      .replace(/\bpart\s*\d+/gi, "")
      .replace(/\bpart\s+(?:ii|iii|iv|v|vi|vii|viii|ix|xi|xii)\b/gi, "")
      .replace(/\b(\d+)(?:st|nd|rd|th)\s+season\b/gi, "")
      .replace(/\bfinal\s+season\b/gi, "")
      .replace(/\bsecond|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth\b/gi, "")
      .replace(/\bseason\b/gi, "")
      .replace(/\s{2,}/g, " ")
      .trim();

    const baseKey = slugify(stripped);
    if (baseKey && baseKey.length > 2) {
      if (!seasonMap.has(baseKey)) seasonMap.set(baseKey, []);
      seasonMap.get(baseKey)!.push({ ...show, stripped_title: stripped });
    }
  }

  const seasonGroup: DuplicateGroup = {
    category: "season_split_detection",
    description: "Shows where title contains season markers (Temporada, Season, TP2, etc.) and multiple entries exist for the same base title.",
    severity: "medium",
    groups: [],
  };
  for (const [key, entries] of seasonMap) {
    if (entries.length > 1) {
      const ids = entries.map((e) => e.id);
      const shows = await p.show.findMany({
        where: { id: { in: ids } },
        include: { _count: { select: { episodes: true } } },
      });
      seasonGroup.groups.push({
        key,
        shows: shows.map((s) => ({
          id: s.id, title: s.title, normalized_title: s.normalized_title,
          base_normalized_title: s.base_normalized_title, category: s.category,
          year: s.year, tmdb_id: s.tmdb_id, mal_id: s.mal_id,
          episode_count: s._count.episodes, source: s.source,
          created_at: s.created_at.toISOString(),
        })),
      });
    }
  }
  seasonGroup.groups.sort((a, b) => b.shows.length - a.shows.length);
  allGroups.push(seasonGroup);
  console.log(`  Found ${seasonGroup.groups.length} groups`);

  // ──────────────────────────────────────────────────────────────────
  // 7. SEQUEL DETECTION (same franchise, different TMDB IDs)
  // ──────────────────────────────────────────────────────────────────
  console.log("7/8 Sequel detection...");
  // Detect franchise patterns: titles ending in numbers or roman numerals
  // "Naruto" + "Naruto Shippuden" / "Dragon Ball" + "Dragon Ball Z"
  const sequelCandidates = await p.$queryRawUnsafe(`
    SELECT id, title, normalized_title, base_normalized_title, category, year,
           tmdb_id, mal_id, source, created_at
    FROM "Show"
    WHERE title ~ '\\d+$'
       OR title ~ '(?:ii|iii|iv|v|vi|vii|viii|ix|xi|xii)$'
       OR title ~ '(?:the\\s+)?(?:movie|pelicula|film|2nd|3rd|4th|5th|6th|7th|8th|9th|10th)\\s*$'
    ORDER BY title
  `) as any[];

  const sequelGroup: DuplicateGroup = {
    category: "sequel_detection",
    description: "Shows likely to be sequels (same franchise) stored separately with different tmdb_ids.",
    severity: "medium",
    groups: [],
  };

  // Group by base franchise: strip trailing numbers/roman numerals
  const franchiseMap = new Map<string, any[]>();
  for (const show of sequelCandidates) {
    const franchiseKey = show.title
      .replace(/\s+\d+$/, "")
      .replace(/\s+(ii|iii|iv|v|vi|vii|viii|ix|xi|xii)$/i, "")
      .replace(/\s+(?:the\s+)?(?:movie|pelicula|film|2nd|3rd|4th|5th|6th|7th|8th|9th|10th)\s*$/i, "")
      .trim();
    const normKey = slugify(franchiseKey);
    if (normKey && normKey.length > 2) {
      if (!franchiseMap.has(normKey)) franchiseMap.set(normKey, []);
      franchiseMap.get(normKey)!.push(show);
    }
  }

  for (const [key, entries] of franchiseMap) {
    if (entries.length > 1) {
      const ids = entries.map((e) => e.id);
      const shows = await p.show.findMany({
        where: { id: { in: ids } },
        include: { _count: { select: { episodes: true } } },
      });
      sequelGroup.groups.push({
        key,
        shows: shows.map((s) => ({
          id: s.id, title: s.title, normalized_title: s.normalized_title,
          base_normalized_title: s.base_normalized_title, category: s.category,
          year: s.year, tmdb_id: s.tmdb_id, mal_id: s.mal_id,
          episode_count: s._count.episodes, source: s.source,
          created_at: s.created_at.toISOString(),
        })),
      });
    }
  }
  sequelGroup.groups.sort((a, b) => b.shows.length - a.shows.length);
  allGroups.push(sequelGroup);
  console.log(`  Found ${sequelGroup.groups.length} groups`);

  // ──────────────────────────────────────────────────────────────────
  // 8. CROSS-PLATFORM DUPLICATES
  // ──────────────────────────────────────────────────────────────────
  console.log("8/8 Cross-platform duplicates...");
  // Shows from different sources with similar base titles
  const crossPlat = await p.$queryRawUnsafe(`
    SELECT base_normalized_title, source, COUNT(*)::int AS cnt,
           ARRAY_AGG(id ORDER BY created_at) AS ids
    FROM "Show"
    WHERE base_normalized_title IS NOT NULL AND base_normalized_title != ''
      AND source IS NOT NULL AND source != ''
    GROUP BY base_normalized_title, source
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
  `) as any[];

  const crossGroup: DuplicateGroup = {
    category: "cross_platform_duplicates",
    description: "Same content appearing from different scrapers/platforms with slightly different titles.",
    severity: "medium",
    groups: [],
  };

  // Now group by base_normalized_title across different sources
  const crossPlatformMap = new Map<string, any[]>();
  const allCrossIds = new Set<string>();
  for (const row of crossPlat) {
    const ids: string[] = row.ids;
    for (const id of ids) allCrossIds.add(id);
  }

  // Also detect cross-platform by normalized_title similarity (fuzzy)
  // Get all shows with different sources but same normalized_title (already in normGroup)
  // But also check base_normalized_title across sources
  const crossBaseNorm = await p.$queryRawUnsafe(`
    SELECT base_normalized_title, COUNT(DISTINCT source)::int AS source_count,
           COUNT(*)::int AS total_shows,
           ARRAY_AGG(id ORDER BY created_at) AS ids
    FROM "Show"
    WHERE base_normalized_title IS NOT NULL AND base_normalized_title != ''
      AND source IS NOT NULL AND source != ''
    GROUP BY base_normalized_title
    HAVING COUNT(DISTINCT source) > 1 AND COUNT(*) > 1
    ORDER BY total_shows DESC
  `) as any[];

  for (const row of crossBaseNorm) {
    const ids: string[] = row.ids;
    const shows = await p.show.findMany({
      where: { id: { in: ids } },
      include: { _count: { select: { episodes: true } } },
    });
    crossGroup.groups.push({
      key: `${row.base_normalized_title} (${row.source_count} sources)`,
      shows: shows.map((s) => ({
        id: s.id, title: s.title, normalized_title: s.normalized_title,
        base_normalized_title: s.base_normalized_title, category: s.category,
        year: s.year, tmdb_id: s.tmdb_id, mal_id: s.mal_id,
        episode_count: s._count.episodes, source: s.source,
        created_at: s.created_at.toISOString(),
      })),
    });
  }
  crossGroup.groups.sort((a, b) => b.shows.length - a.shows.length);
  allGroups.push(crossGroup);
  console.log(`  Found ${crossGroup.groups.length} groups`);

  // ──────────────────────────────────────────────────────────────────
  // MEDIAITEM DUPLICATES (by normalized_title + kind + year)
  // ──────────────────────────────────────────────────────────────────
  console.log("\nMediaItem duplicates...");
  const miDups = await p.$queryRawUnsafe(`
    SELECT normalized_title, kind, year, COUNT(*)::int AS cnt,
           ARRAY_AGG(id ORDER BY created_at) AS ids
    FROM "MediaItem"
    GROUP BY normalized_title, kind, year
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
  `) as any[];

  const miGroup: DuplicateGroup = {
    category: "mediaitem_duplicates",
    description: "MediaItems sharing the same normalized_title+kind+year. Violates the @@unique constraint (should not exist after proper dedup).",
    severity: "high",
    groups: [],
  };
  for (const row of miDups) {
    const ids: string[] = row.ids;
    miGroup.groups.push({
      key: `${row.normalized_title} [${row.kind}] ${row.year ?? "null"}`,
      shows: ids.map((id: string) => ({
        id,
        title: row.normalized_title,
        normalized_title: row.normalized_title,
        base_normalized_title: null,
        category: row.kind,
        year: row.year,
        tmdb_id: null,
        mal_id: null,
        episode_count: 0,
        source: "",
        created_at: "",
      })),
    });
  }
  allGroups.push(miGroup);
  console.log(`  Found ${miDups.length} groups`);

  // ──────────────────────────────────────────────────────────────────
  // TITLE NOISE ANALYSIS
  // ──────────────────────────────────────────────────────────────────
  console.log("\nTitle noise analysis...");
  const allShowsNoise = await p.$queryRawUnsafe(`
    SELECT id, title, normalized_title, category, year
    FROM "Show"
    ORDER BY title
  `) as any[];

  const noiseCounts = new Map<string, number>();
  for (const show of allShowsNoise) {
    const tokens = show.title.split(/\s+/);
    let hasNoise = false;
    for (const token of tokens) {
      const norm = slugify(token);
      if (NOISE_TOKENS.has(norm) || TITLE_NOISE_RE.test(token)) {
        hasNoise = true;
        noiseCounts.set(norm, (noiseCounts.get(norm) || 0) + 1);
      }
    }
    // Also check for season noise in title
    if (SEASON_NOISE_RE.test(show.title)) {
      hasNoise = true;
    }

    if (hasNoise) {
      const foundTokens: string[] = [];
      for (const token of tokens) {
        const norm = slugify(token);
        if (NOISE_TOKENS.has(norm)) foundTokens.push(norm);
      }
      const shows = await p.show.findMany({
        where: { id: show.id },
        include: { _count: { select: { episodes: true } } },
      });
      allNoise.push({
        id: show.id,
        title: show.title,
        category: show.category,
        year: show.year,
        noise_tokens_found: foundTokens,
        normalized_title: show.normalized_title,
        episode_count: shows[0]?._count.episodes || 0,
      });
    }
  }

  const topNoise = Array.from(noiseCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([token, count]) => ({ token, count }));

  const noiseAnalysis = {
    category: "title_noise_analysis",
    description: "Shows with titles containing scraping artifacts (Latino, HD, Ver online, Sub Español, etc.)",
    severity: "medium" as const,
    total_noisy: allNoise.length,
    top_noise_tokens: topNoise,
    entries: allNoise.slice(0, 200), // Cap at 200 for report size
  };

  // ──────────────────────────────────────────────────────────────────
  // BUILD REPORT
  // ──────────────────────────────────────────────────────────────────
  const summary = {
    total_duplicate_groups: allGroups.reduce((acc, g) => acc + g.groups.length, 0),
    total_duplicate_shows: allGroups.reduce(
      (acc, g) => acc + g.groups.reduce((a2, gr) => a2 + gr.shows.length, 0),
      0
    ),
    severity_high: allGroups.filter((g) => g.severity === "high").reduce((a, g) => a + g.groups.length, 0),
    severity_medium: allGroups.filter((g) => g.severity === "medium").reduce((a, g) => a + g.groups.length, 0),
    severity_low: allGroups.filter((g) => g.severity === "low").reduce((a, g) => a + g.groups.length, 0),
  };

  const report: Report = {
    generated_at: new Date().toISOString(),
    total_shows: totalShows,
    total_episodes: totalEps,
    total_media_items: totalMI,
    sections: {
      exact_title_duplicates: allGroups.find((g) => g.category === "exact_title_duplicates")!,
      normalized_title_duplicates: allGroups.find((g) => g.category === "normalized_title_duplicates")!,
      base_normalized_duplicates: allGroups.find((g) => g.category === "base_normalized_duplicates")!,
      same_tmdb_id: allGroups.find((g) => g.category === "same_tmdb_id")!,
      same_mal_id: allGroups.find((g) => g.category === "same_mal_id")!,
      season_split_detection: allGroups.find((g) => g.category === "season_split_detection")!,
      sequel_detection: allGroups.find((g) => g.category === "sequel_detection")!,
      cross_platform_duplicates: allGroups.find((g) => g.category === "cross_platform_duplicates")!,
      mediaitem_duplicates: allGroups.find((g) => g.category === "mediaitem_duplicates")!,
      title_noise_analysis: noiseAnalysis,
    },
    summary,
  };

  const outPath = join("data", "audit-duplicates.json");
  writeFileSync(outPath, JSON.stringify(report, null, 2), "utf-8");

  // ──────────────────────────────────────────────────────────────────
  // CONSOLE SUMMARY
  // ──────────────────────────────────────────────────────────────────
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  DUPLICATE AUDIT COMPLETE`);
  console.log(`${"═".repeat(60)}`);
  console.log(`\n  Total Shows:    ${totalShows}`);
  console.log(`  Total Episodes: ${totalEps}`);
  console.log(`  Total MediaItems: ${totalMI}\n`);

  for (const g of allGroups) {
    const sevIcon = g.severity === "high" ? "🔴" : g.severity === "medium" ? "🟡" : "🟢";
    console.log(`${sevIcon} [${g.severity.toUpperCase()}] ${g.category}: ${g.groups.length} groups`);
    for (const grp of g.groups.slice(0, 10)) {
      console.log(`    └─ "${grp.key}" (${grp.shows.length} shows)`);
      for (const s of grp.shows.slice(0, 5)) {
        console.log(`       • [${s.id.slice(0, 8)}] "${s.title}" (${s.category}, ${s.year}) ${s.episode_count} eps src=${s.source || "?"}`);
      }
      if (grp.shows.length > 5) console.log(`       ... and ${grp.shows.length - 5} more`);
    }
    if (g.groups.length > 10) console.log(`    ... and ${g.groups.length - 10} more groups\n`);
    else console.log();
  }

  console.log(`🟡 Title noise: ${noiseAnalysis.total_noisy} shows with scraping artifacts`);
  console.log(`  Top noise tokens: ${topNoise.slice(0, 8).map((t) => `${t.token}(${t.count})`).join(", ")}`);
  console.log(`\n  Report saved to: ${outPath}`);
  console.log(`${"═".repeat(60)}\n`);

  await p.$disconnect();
})();
