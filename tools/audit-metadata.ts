import { PrismaClient } from "@prisma/client";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const DATABASE_URL = "postgresql://voidstream:voidstream123@192.168.18.3:5433/voidstream?schema=public";

const p = new PrismaClient({
  datasources: { db: { url: DATABASE_URL } },
});

interface AuditReport {
  timestamp: string;
  totalShows: number;
  categoryDistribution: Record<string, number>;
  yearAnalysis: {
    nullCount: number;
    zeroCount: number;
    defaultCount: number;
    futureYearCount: number;
    veryOldCount: number;
    suspiciousYears: { year: number; count: number }[];
    distribution: { year: number; count: number }[];
  };
  genreAnalysis: {
    defaultMultimedia: number;
    emptyGenres: number;
    topGenres: { genre: string; count: number }[];
  };
  statusAnalysis: {
    distribution: Record<string, number>;
    finalizadoCount: number;
    enEmisionCount: number;
  };
  ratingAnalysis: {
    defaultRating: number;
    distribution: { rating_bucket: string; count: number }[];
  };
  sourceAnalysis: {
    bySource: { source: string; count: number }[];
    emptySource: number;
  };
  emptyFieldDetection: {
    allDefaults: number;
    partialDefaults: number;
    completelyEmpty: number;
    worstOffenders: {
      title: string;
      category: string;
      rating: number;
      year: number;
      genres: string;
      status: string;
      description: string;
      source: string;
    }[];
  };
  descriptionQuality: {
    byCategory: {
      category: string;
      avglength: number;
      emptycount: number;
      shortcount: number;
      totalcount: number;
    }[];
    overallEmpty: number;
    overallShort: number;
  };
  episodeCorrelation: {
    showsWithMostEpisodes: { title: string; category: string; episodecount: number }[];
    showsWithZeroEpisodes: number;
  };
}

async function main() {
  await p.$connect();

  console.log("=== CATALOG METADATA DEEP AUDIT ===\n");

  const totalShows = await p.show.count();
  console.log(`Total shows in database: ${totalShows}\n`);

  // 1. CATEGORY DISTRIBUTION
  console.log("--- 1. CATEGORY DISTRIBUTION ---");
  const categoryRows = await p.$queryRawUnsafe<{ category: string; count: number }[]>(`
    SELECT category, COUNT(*)::int as count FROM "Show"
    GROUP BY category ORDER BY count DESC
  `);
  const categoryDistribution: Record<string, number> = {};
  for (const row of categoryRows) {
    categoryDistribution[row.category] = row.count;
    console.log(`  ${row.category}: ${row.count} (${Math.round(row.count / totalShows * 100)}%)`);
  }

  // 2. YEAR ANALYSIS
  console.log("\n--- 2. YEAR ANALYSIS ---");
  const yearNull = await p.$queryRawUnsafe<{ count: number }[]>(`
    SELECT COUNT(*)::int as count FROM "Show" WHERE year IS NULL
  `);
  const yearZero = await p.$queryRawUnsafe<{ count: number }[]>(`
    SELECT COUNT(*)::int as count FROM "Show" WHERE year = 0
  `);
  const yearDefault = await p.$queryRawUnsafe<{ count: number }[]>(`
    SELECT COUNT(*)::int as count FROM "Show" WHERE year = 2024
  `);
  const yearFuture = await p.$queryRawUnsafe<{ count: number }[]>(`
    SELECT COUNT(*)::int as count FROM "Show" WHERE year > 2026
  `);
  const yearVeryOld = await p.$queryRawUnsafe<{ count: number }[]>(`
    SELECT COUNT(*)::int as count FROM "Show" WHERE year > 0 AND year < 1950
  `);
  const suspiciousYears = await p.$queryRawUnsafe<{ year: number; count: number }[]>(`
    SELECT year, COUNT(*)::int as count FROM "Show"
    WHERE year = 0 OR year IS NULL OR year > 2026 OR (year > 0 AND year < 1950)
    GROUP BY year ORDER BY count DESC
  `);
  const yearDistribution = await p.$queryRawUnsafe<{ year: number; count: number }[]>(`
    SELECT year, COUNT(*)::int as count FROM "Show"
    GROUP BY year ORDER BY year
  `);

  console.log(`  year = NULL: ${yearNull[0].count}`);
  console.log(`  year = 0: ${yearZero[0].count}`);
  console.log(`  year = 2024 (default): ${yearDefault[0].count} (${Math.round(yearDefault[0].count / totalShows * 100)}%)`);
  console.log(`  Future years (>2026): ${yearFuture[0].count}`);
  console.log(`  Very old (<1950): ${yearVeryOld[0].count}`);
  console.log(`  Year distribution:`);
  for (const y of yearDistribution) {
    console.log(`    ${y.year}: ${"#".repeat(Math.max(1, Math.round(y.count / 20)))} ${y.count}`);
  }

  // 3. GENRE ANALYSIS
  console.log("\n--- 3. GENRE ANALYSIS ---");
  const genreDefault = await p.$queryRawUnsafe<{ count: number }[]>(`
    SELECT COUNT(*)::int as count FROM "Show" WHERE genres = 'Multimedia'
  `);
  const genreEmpty = await p.$queryRawUnsafe<{ count: number }[]>(`
    SELECT COUNT(*)::int as count FROM "Show" WHERE genres = '' OR genres IS NULL
  `);
  const topGenres = await p.$queryRawUnsafe<{ genre: string; count: number }[]>(`
    SELECT genres as genre, COUNT(*)::int as count FROM "Show"
    WHERE genres != '' AND genres IS NOT NULL AND genres != 'Multimedia'
    GROUP BY genres ORDER BY count DESC LIMIT 20
  `);
  console.log(`  Default 'Multimedia': ${genreDefault[0].count} (${Math.round(genreDefault[0].count / totalShows * 100)}%)`);
  console.log(`  Empty genres: ${genreEmpty[0].count}`);
  console.log(`  Top genres:`);
  for (const g of topGenres) {
    console.log(`    "${g.genre}": ${g.count}`);
  }

  // 4. STATUS ANALYSIS
  console.log("\n--- 4. STATUS ANALYSIS ---");
  const statusRows = await p.$queryRawUnsafe<{ status: string; count: number }[]>(`
    SELECT status, COUNT(*)::int as count FROM "Show"
    GROUP BY status ORDER BY count DESC
  `);
  const statusDistribution: Record<string, number> = {};
  let finalizadoCount = 0;
  let enEmisionCount = 0;
  for (const row of statusRows) {
    statusDistribution[row.status] = row.count;
    if (row.status === "Finalizado") finalizadoCount = row.count;
    if (row.status === "En emisión" || row.status === "Ongoing") enEmisionCount += row.count;
    console.log(`  "${row.status}": ${row.count} (${Math.round(row.count / totalShows * 100)}%)`);
  }

  // 5. RATING ANALYSIS
  console.log("\n--- 5. RATING ANALYSIS ---");
  const ratingDefault = await p.$queryRawUnsafe<{ count: number }[]>(`
    SELECT COUNT(*)::int as count FROM "Show" WHERE rating = 8.0
  `);
  const ratingDistribution = await p.$queryRawUnsafe<{ rating_bucket: string; count: number }[]>(`
    SELECT * FROM (
      SELECT
        CASE
          WHEN rating = 8.0 THEN '8.0 (default)'
          WHEN rating >= 9.0 THEN '9.0-10.0'
          WHEN rating > 8.0 THEN '8.0-8.9'
          WHEN rating >= 7.0 THEN '7.0-7.9'
          WHEN rating >= 6.0 THEN '6.0-6.9'
          WHEN rating >= 5.0 THEN '5.0-5.9'
          WHEN rating >= 4.0 THEN '4.0-4.9'
          WHEN rating >= 3.0 THEN '3.0-3.9'
          WHEN rating >= 2.0 THEN '2.0-2.9'
          WHEN rating >= 1.0 THEN '1.0-1.9'
          ELSE '0.0-0.9'
        END as rating_bucket,
        COUNT(*)::int as count,
        CASE
          WHEN rating = 8.0 THEN 0
          WHEN rating >= 9.0 THEN 1
          WHEN rating > 8.0 THEN 2
          WHEN rating >= 7.0 THEN 3
          WHEN rating >= 6.0 THEN 4
          WHEN rating >= 5.0 THEN 5
          WHEN rating >= 4.0 THEN 6
          WHEN rating >= 3.0 THEN 7
          WHEN rating >= 2.0 THEN 8
          WHEN rating >= 1.0 THEN 9
          ELSE 10
        END as sort_key
      FROM "Show"
      GROUP BY 1, 3
    ) sub
    ORDER BY sort_key
  `);
  console.log(`  Default rating 8.0: ${ratingDefault[0].count} (${Math.round(ratingDefault[0].count / totalShows * 100)}%)`);
  console.log(`  Distribution:`);
  for (const r of ratingDistribution) {
    console.log(`    ${r.rating_bucket}: ${r.count}`);
  }

  // 6. SOURCE/PLATFORM ANALYSIS
  console.log("\n--- 6. SOURCE/PLATFORM ANALYSIS ---");
  const sourceRows = await p.$queryRawUnsafe<{ source: string; count: number }[]>(`
    SELECT source, COUNT(*)::int as count FROM "Show"
    GROUP BY source ORDER BY count DESC
  `);
  const sourceEmpty = sourceRows.find((r) => r.source === "" || r.source === null);
  console.log(`  Empty source: ${sourceEmpty?.count ?? 0} (${Math.round((sourceEmpty?.count ?? 0) / totalShows * 100)}%)`);
  console.log(`  Sources:`);
  for (const s of sourceRows) {
    const label = s.source === "" ? "(empty)" : s.source;
    console.log(`    "${label}": ${s.count}`);
  }

  // 7. EMPTY/DEFAULT FIELD DETECTION
  console.log("\n--- 7. EMPTY/DEFAULT FIELD DETECTION ---");
  const allDefaults = await p.$queryRawUnsafe<{ count: number }[]>(`
    SELECT COUNT(*)::int as count FROM "Show"
    WHERE rating = 8.0 AND year = 2024 AND genres = 'Multimedia' AND status = 'Finalizado'
  `);
  const completelyEmpty = await p.$queryRawUnsafe<{ count: number }[]>(`
    SELECT COUNT(*)::int as count FROM "Show"
    WHERE (description = '' OR description IS NULL)
      AND (poster_url = '' OR poster_url IS NULL)
      AND genres = 'Multimedia'
      AND rating = 8.0
      AND year = 2024
  `);
  const worstOffenders = await p.$queryRawUnsafe<{
    title: string;
    category: string;
    rating: number;
    year: number;
    genres: string;
    status: string;
    description: string;
    source: string;
  }[]>(`
    SELECT title, category, rating, year, genres, status,
           LEFT(description, 100) as description, source
    FROM "Show"
    WHERE rating = 8.0 AND year = 2024 AND genres = 'Multimedia' AND status = 'Finalizado'
    LIMIT 20
  `);
  const partialDefaults = await p.$queryRawUnsafe<{ count: number }[]>(`
    SELECT COUNT(*)::int as count FROM "Show"
    WHERE (CASE WHEN rating = 8.0 THEN 1 ELSE 0 END)
        + (CASE WHEN year = 2024 THEN 1 ELSE 0 END)
        + (CASE WHEN genres = 'Multimedia' THEN 1 ELSE 0 END)
        + (CASE WHEN status = 'Finalizado' THEN 1 ELSE 0 END) >= 3
  `);

  console.log(`  All defaults (rating=8, year=2024, genres=Multimedia, status=Finalizado): ${allDefaults[0].count} (${Math.round(allDefaults[0].count / totalShows * 100)}%)`);
  console.log(`  Partial defaults (3+ of 4): ${partialDefaults[0].count} (${Math.round(partialDefaults[0].count / totalShows * 100)}%)`);
  console.log(`  Completely empty (no desc, no poster, all defaults): ${completelyEmpty[0].count}`);
  console.log(`  Worst offenders (sample):`);
  for (const w of worstOffenders) {
    console.log(`    "${w.title}" [${w.category}] - ${w.year}, ${w.rating}, "${w.genres}", "${w.status}"`);
  }

  // 8. DESCRIPTION QUALITY BY CATEGORY
  console.log("\n--- 8. DESCRIPTION QUALITY BY CATEGORY ---");
  const descByCategory = await p.$queryRawUnsafe<{
    category: string;
    avglength: number;
    totalcount: number;
    emptycount: number;
    shortcount: number;
  }[]>(`
    SELECT
      s.category,
      COALESCE(AVG(LENGTH(s.description)), 0)::int as "avglength",
      COUNT(*)::int as "totalcount",
      COUNT(CASE WHEN s.description = '' OR s.description IS NULL THEN 1 END)::int as "emptycount",
      COUNT(CASE WHEN LENGTH(s.description) > 0 AND LENGTH(s.description) < 50 THEN 1 END)::int as "shortcount"
    FROM "Show" s
    GROUP BY s.category
    ORDER BY "totalcount" DESC
  `);
  const overallEmpty = descByCategory.reduce((acc, r) => acc + r.emptycount, 0);
  const overallShort = descByCategory.reduce((acc, r) => acc + r.shortcount, 0);
  console.log(`  Overall empty descriptions: ${overallEmpty}`);
  console.log(`  Overall short descriptions (<50 chars): ${overallShort}`);
  console.log(`  By category:`);
  for (const d of descByCategory) {
    const emptyPct = Math.round(d.emptycount / d.totalcount * 100);
    const shortPct = Math.round(d.shortcount / d.totalcount * 100);
    console.log(`    ${d.category}: avg=${d.avglength} chars, empty=${d.emptycount} (${emptyPct}%), short=${d.shortcount} (${shortPct}%), total=${d.totalcount}`);
  }

  // 9. EPISODE CORRELATION
  console.log("\n--- 9. EPISODE CORRELATION ---");
  const showsWithMostEps = await p.$queryRawUnsafe<{
    title: string;
    category: string;
    episodecount: number;
  }[]>(`
    SELECT s.title, s.category, COUNT(e.id)::int as "episodecount"
    FROM "Show" s
    INNER JOIN "Episode" e ON e.show_id = s.id
    GROUP BY s.id
    ORDER BY "episodecount" DESC
    LIMIT 10
  `);
  const showsZeroEps = await p.show.count({ where: { episodes: { none: {} } } });
  console.log(`  Shows with 0 episodes: ${showsZeroEps}`);
  console.log(`  Top shows by episode count:`);
  for (const s of showsWithMostEps) {
    console.log(`    "${s.title}" [${s.category}] - ${s.episodecount} episodes`);
  }

  // 10. CROSS-ANALYSIS: Category vs Default Fields
  console.log("\n--- 10. CATEGORY vs DEFAULT FIELDS ---");
  const catDefaults = await p.$queryRawUnsafe<{
    category: string;
    totalcount: number;
    defaultrating: number;
    defaultyear: number;
    defaultgenres: number;
    defaultstatus: number;
  }[]>(`
    SELECT
      category,
      COUNT(*)::int as "totalcount",
      COUNT(CASE WHEN rating = 8.0 THEN 1 END)::int as "defaultrating",
      COUNT(CASE WHEN year = 2024 THEN 1 END)::int as "defaultyear",
      COUNT(CASE WHEN genres = 'Multimedia' THEN 1 END)::int as "defaultgenres",
      COUNT(CASE WHEN status = 'Finalizado' THEN 1 END)::int as "defaultstatus"
    FROM "Show"
    GROUP BY category
    ORDER BY "totalcount" DESC
  `);
  for (const c of catDefaults) {
    const dr = Math.round(c.defaultrating / c.totalcount * 100);
    const dy = Math.round(c.defaultyear / c.totalcount * 100);
    const dg = Math.round(c.defaultgenres / c.totalcount * 100);
    const ds = Math.round(c.defaultstatus / c.totalcount * 100);
    console.log(`  ${c.category}: total=${c.totalcount}, defaultRating=${dr}%, defaultYear=${dy}%, defaultGenres=${dg}%, defaultStatus=${ds}%`);
  }

  // BUILD REPORT
  const report: AuditReport = {
    timestamp: new Date().toISOString(),
    totalShows,
    categoryDistribution,
    yearAnalysis: {
      nullCount: yearNull[0].count,
      zeroCount: yearZero[0].count,
      defaultCount: yearDefault[0].count,
      futureYearCount: yearFuture[0].count,
      veryOldCount: yearVeryOld[0].count,
      suspiciousYears,
      distribution: yearDistribution,
    },
    genreAnalysis: {
      defaultMultimedia: genreDefault[0].count,
      emptyGenres: genreEmpty[0].count,
      topGenres,
    },
    statusAnalysis: {
      distribution: statusDistribution,
      finalizadoCount,
      enEmisionCount,
    },
    ratingAnalysis: {
      defaultRating: ratingDefault[0].count,
      distribution: ratingDistribution,
    },
    sourceAnalysis: {
      bySource: sourceRows,
      emptySource: sourceEmpty?.count ?? 0,
    },
    emptyFieldDetection: {
      allDefaults: allDefaults[0].count,
      partialDefaults: partialDefaults[0].count,
      completelyEmpty: completelyEmpty[0].count,
      worstOffenders,
    },
    descriptionQuality: {
      byCategory: descByCategory,
      overallEmpty,
      overallShort,
    },
    episodeCorrelation: {
      showsWithMostEpisodes: showsWithMostEps,
      showsWithZeroEpisodes: showsZeroEps,
    },
  };

  // SAVE REPORT
  const dataDir = join(import.meta.dirname || process.cwd(), "..", "data");
  try { mkdirSync(dataDir, { recursive: true }); } catch {}
  const outputPath = join(dataDir, "audit-metadata.json");
  writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(`\n=== Report saved to ${outputPath} ===`);

  await p.$disconnect();
}

main().catch((err) => {
  console.error("Audit failed:", err);
  process.exit(1);
});
