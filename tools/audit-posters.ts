import { PrismaClient } from "@prisma/client";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const p = new PrismaClient();

interface AuditResult {
  timestamp: string;
  total_shows: number;
  categories: {
    missing_posters: { count: number; percent: number; samples: any[] };
    relative_urls: { count: number; percent: number; samples: any[] };
    low_quality: {
      veranimes_cdn: { count: number; samples: any[] };
      unsplash: { count: number; samples: any[] };
      placeholder: { count: number; samples: any[] };
      very_short: { count: number; samples: any[] };
    };
    invalid_urls: { count: number; percent: number; samples: any[] };
    same_poster_banner: { count: number; percent: number; samples: any[] };
    missing_backdrop: { count: number; percent: number; samples: any[] };
    http_insecure: { count: number; percent: number; samples: any[] };
  };
  domain_breakdown: { domain: string; count: number; percent: number }[];
  summary: {
    total_issues: number;
    shows_affected: number;
    healthy_shows: number;
    health_score: number;
  };
}

async function count(q: string): Promise<number> {
  const r = (await p.$queryRawUnsafe(q)) as any[];
  return r[0]?.count ?? 0;
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "invalid-url";
  }
}

(async () => {
  await p.$connect();
  mkdirSync(join(process.cwd(), "data"), { recursive: true });

  const totalShows = await count(`SELECT COUNT(*)::int as count FROM "Show"`);
  console.log(`\n${"=".repeat(70)}`);
  console.log(`  AUDITORÍA DE POSTERS E IMÁGENES — ${totalShows} shows`);
  console.log(`${"=".repeat(70)}\n`);

  const report: AuditResult = {
    timestamp: new Date().toISOString(),
    total_shows: totalShows,
    categories: {
      missing_posters: { count: 0, percent: 0, samples: [] },
      relative_urls: { count: 0, percent: 0, samples: [] },
      low_quality: {
        veranimes_cdn: { count: 0, samples: [] },
        unsplash: { count: 0, samples: [] },
        placeholder: { count: 0, samples: [] },
        very_short: { count: 0, samples: [] },
      },
      invalid_urls: { count: 0, percent: 0, samples: [] },
      same_poster_banner: { count: 0, percent: 0, samples: [] },
      missing_backdrop: { count: 0, percent: 0, samples: [] },
      http_insecure: { count: 0, percent: 0, samples: [] },
    },
    domain_breakdown: [],
    summary: { total_issues: 0, shows_affected: 0, healthy_shows: 0, health_score: 0 },
  };

  // ── 1. Missing posters (null or empty) ──
  const mpCount = await count(`
    SELECT COUNT(*)::int as count FROM "Show"
    WHERE poster_url IS NULL OR TRIM(poster_url) = ''
  `);
  report.categories.missing_posters.count = mpCount;
  report.categories.missing_posters.percent = Math.round((mpCount / totalShows) * 100);
  report.categories.missing_posters.samples = await p.$queryRawUnsafe(`
    SELECT id, title, category, poster_url, banner_url
    FROM "Show" WHERE poster_url IS NULL OR TRIM(poster_url) = ''
    ORDER BY created_at DESC LIMIT 20
  `);
  console.log(`1. POSTERS FALTANTES (null o vacío): ${mpCount} (${report.categories.missing_posters.percent}%)`);
  for (const s of report.categories.missing_posters.samples.slice(0, 5))
    console.log(`   - [${s.id.slice(0, 8)}] "${s.title}" (${s.category})`);

  // ── 2. Relative URLs ──
  const ruCount = await count(`
    SELECT COUNT(*)::int as count FROM "Show"
    WHERE poster_url IS NOT NULL AND TRIM(poster_url) != '' AND poster_url LIKE '/%'
  `);
  report.categories.relative_urls.count = ruCount;
  report.categories.relative_urls.percent = Math.round((ruCount / totalShows) * 100);
  report.categories.relative_urls.samples = await p.$queryRawUnsafe(`
    SELECT id, title, category, poster_url
    FROM "Show" WHERE poster_url IS NOT NULL AND TRIM(poster_url) != '' AND poster_url LIKE '/%'
    ORDER BY created_at DESC LIMIT 20
  `);
  console.log(`\n2. URLs RELATIVAS (empiezan con /): ${ruCount} (${report.categories.relative_urls.percent}%)`);
  for (const s of report.categories.relative_urls.samples.slice(0, 5))
    console.log(`   - [${s.id.slice(0, 8)}] "${s.title}" → ${s.poster_url}`);

  // ── 3. Low-quality sources ──
  // 3a. VerAnimes CDN
  const vaCount = await count(`
    SELECT COUNT(*)::int as count FROM "Show" WHERE poster_url LIKE '%veranimes.net%'
  `);
  report.categories.low_quality.veranimes_cdn.count = vaCount;
  report.categories.low_quality.veranimes_cdn.samples = await p.$queryRawUnsafe(`
    SELECT id, title, poster_url FROM "Show" WHERE poster_url LIKE '%veranimes.net%'
    ORDER BY created_at DESC LIMIT 20
  `);

  // 3b. Unsplash
  const usCount = await count(`
    SELECT COUNT(*)::int as count FROM "Show" WHERE poster_url LIKE '%images.unsplash.com%'
  `);
  report.categories.low_quality.unsplash.count = usCount;
  report.categories.low_quality.unsplash.samples = await p.$queryRawUnsafe(`
    SELECT id, title, poster_url FROM "Show" WHERE poster_url LIKE '%images.unsplash.com%'
    ORDER BY created_at DESC LIMIT 20
  `);

  // 3c. Placeholder / generic
  const phCount = await count(`
    SELECT COUNT(*)::int as count FROM "Show"
    WHERE poster_url IS NOT NULL AND (
      LOWER(poster_url) LIKE '%placeholder%'
      OR LOWER(poster_url) LIKE '%default_poster%'
      OR LOWER(poster_url) LIKE '%no-image%'
      OR LOWER(poster_url) LIKE '%no_image%'
      OR LOWER(poster_url) LIKE '%default.jpg%'
      OR LOWER(poster_url) LIKE '%missing%'
    )
  `);
  report.categories.low_quality.placeholder.count = phCount;
  report.categories.low_quality.placeholder.samples = await p.$queryRawUnsafe(`
    SELECT id, title, poster_url FROM "Show"
    WHERE poster_url IS NOT NULL AND (
      LOWER(poster_url) LIKE '%placeholder%'
      OR LOWER(poster_url) LIKE '%default_poster%'
      OR LOWER(poster_url) LIKE '%no-image%'
      OR LOWER(poster_url) LIKE '%no_image%'
      OR LOWER(poster_url) LIKE '%default.jpg%'
      OR LOWER(poster_url) LIKE '%missing%'
    )
    ORDER BY created_at DESC LIMIT 20
  `);

  // 3d. Very short URLs (<10 chars)
  const vsCount = await count(`
    SELECT COUNT(*)::int as count FROM "Show"
    WHERE poster_url IS NOT NULL AND LENGTH(TRIM(poster_url)) < 10
  `);
  report.categories.low_quality.very_short.count = vsCount;
  report.categories.low_quality.very_short.samples = await p.$queryRawUnsafe(`
    SELECT id, title, poster_url FROM "Show"
    WHERE poster_url IS NOT NULL AND LENGTH(TRIM(poster_url)) < 10
    ORDER BY created_at DESC LIMIT 20
  `);

  console.log(`\n3. FUENTES DE BAJA CALIDAD:`);
  console.log(`   3a. VerAnimes CDN:           ${vaCount}`);
  for (const s of report.categories.low_quality.veranimes_cdn.samples.slice(0, 3))
    console.log(`       - "${s.title}" → ${s.poster_url}`);
  console.log(`   3b. Unsplash genérico:       ${usCount}`);
  for (const s of report.categories.low_quality.unsplash.samples.slice(0, 3))
    console.log(`       - "${s.title}" → ${s.poster_url}`);
  console.log(`   3c. Placeholder/missing:     ${phCount}`);
  for (const s of report.categories.low_quality.placeholder.samples.slice(0, 3))
    console.log(`       - "${s.title}" → ${s.poster_url}`);
  console.log(`   3d. URLs muy cortas (<10):    ${vsCount}`);
  for (const s of report.categories.low_quality.very_short.samples.slice(0, 3))
    console.log(`       - "${s.title}" → ${s.poster_url}`);

  // ── 4. Invalid URLs ──
  const iuCount = await count(`
    SELECT COUNT(*)::int as count FROM "Show"
    WHERE poster_url IS NOT NULL AND TRIM(poster_url) != ''
    AND poster_url NOT LIKE 'http%' AND poster_url NOT LIKE '/%'
  `);
  report.categories.invalid_urls.count = iuCount;
  report.categories.invalid_urls.percent = Math.round((iuCount / totalShows) * 100);
  report.categories.invalid_urls.samples = await p.$queryRawUnsafe(`
    SELECT id, title, category, poster_url FROM "Show"
    WHERE poster_url IS NOT NULL AND TRIM(poster_url) != ''
    AND poster_url NOT LIKE 'http%' AND poster_url NOT LIKE '/%'
    ORDER BY created_at DESC LIMIT 20
  `);
  console.log(`\n4. URLs INVÁLIDAS (no http ni /): ${iuCount} (${report.categories.invalid_urls.percent}%)`);
  for (const s of report.categories.invalid_urls.samples.slice(0, 5))
    console.log(`   - [${s.id.slice(0, 8)}] "${s.title}" → ${s.poster_url}`);

  // ── 5. Same poster and banner ──
  const sbCount = await count(`
    SELECT COUNT(*)::int as count FROM "Show"
    WHERE poster_url IS NOT NULL AND banner_url IS NOT NULL
    AND TRIM(poster_url) = TRIM(banner_url) AND TRIM(poster_url) != ''
  `);
  report.categories.same_poster_banner.count = sbCount;
  report.categories.same_poster_banner.percent = Math.round((sbCount / totalShows) * 100);
  report.categories.same_poster_banner.samples = await p.$queryRawUnsafe(`
    SELECT id, title, category, poster_url FROM "Show"
    WHERE poster_url IS NOT NULL AND banner_url IS NOT NULL
    AND TRIM(poster_url) = TRIM(banner_url) AND TRIM(poster_url) != ''
    ORDER BY created_at DESC LIMIT 20
  `);
  console.log(`\n5. POSTER = BANNER (mismo URL): ${sbCount} (${report.categories.same_poster_banner.percent}%)`);
  for (const s of report.categories.same_poster_banner.samples.slice(0, 5))
    console.log(`   - [${s.id.slice(0, 8)}] "${s.title}" → ${s.poster_url}`);

  // ── 6. Missing backdrop ──
  const bdCount = await count(`
    SELECT COUNT(*)::int as count FROM "Show"
    WHERE backdrop_path IS NULL OR TRIM(backdrop_path) = ''
  `);
  report.categories.missing_backdrop.count = bdCount;
  report.categories.missing_backdrop.percent = Math.round((bdCount / totalShows) * 100);
  report.categories.missing_backdrop.samples = await p.$queryRawUnsafe(`
    SELECT id, title, category FROM "Show"
    WHERE backdrop_path IS NULL OR TRIM(backdrop_path) = ''
    ORDER BY created_at DESC LIMIT 20
  `);
  console.log(`\n6. BACKDROP FALTANTE: ${bdCount} (${report.categories.missing_backdrop.percent}%)`);
  for (const s of report.categories.missing_backdrop.samples.slice(0, 5))
    console.log(`   - [${s.id.slice(0, 8)}] "${s.title}" (${s.category})`);

  // ── 7. HTTP insecure ──
  const hiCount = await count(`
    SELECT COUNT(*)::int as count FROM "Show" WHERE poster_url LIKE 'http://%'
  `);
  report.categories.http_insecure.count = hiCount;
  report.categories.http_insecure.percent = Math.round((hiCount / totalShows) * 100);
  report.categories.http_insecure.samples = await p.$queryRawUnsafe(`
    SELECT id, title, poster_url FROM "Show" WHERE poster_url LIKE 'http://%'
    ORDER BY created_at DESC LIMIT 20
  `);
  console.log(`\n7. HTTP INSEGURO: ${hiCount} (${report.categories.http_insecure.percent}%)`);
  for (const s of report.categories.http_insecure.samples.slice(0, 5))
    console.log(`   - [${s.id.slice(0, 8)}] "${s.title}" → ${s.poster_url}`);

  // ── 8. Domain breakdown ──
  const allPosters = (await p.$queryRawUnsafe(`
    SELECT poster_url FROM "Show"
    WHERE poster_url IS NOT NULL AND TRIM(poster_url) != '' AND poster_url LIKE 'http%'
  `)) as any[];
  const domainCounts: Record<string, number> = {};
  for (const row of allPosters) {
    const domain = extractDomain(row.poster_url);
    domainCounts[domain] = (domainCounts[domain] || 0) + 1;
  }
  const domainBreakdown = Object.entries(domainCounts)
    .map(([domain, count]) => ({ domain, count, percent: Math.round((count / allPosters.length) * 100) }))
    .sort((a, b) => b.count - a.count);
  report.domain_breakdown = domainBreakdown;
  console.log(`\n8. DOMINIOS DE POSTERS (${allPosters.length} URLs válidas):`);
  for (const d of domainBreakdown.slice(0, 15)) {
    const bar = "█".repeat(Math.max(1, Math.round(d.count / (domainBreakdown[0]?.count || 1) * 30)));
    console.log(`   ${d.domain.padEnd(40)} ${String(d.count).padStart(5)} (${d.percent}%) ${bar}`);
  }

  // ── Summary ──
  const allIssueIds = new Set<string>();
  for (const s of report.categories.missing_posters.samples) allIssueIds.add(s.id);
  for (const s of report.categories.relative_urls.samples) allIssueIds.add(s.id);
  for (const s of report.categories.low_quality.veranimes_cdn.samples) allIssueIds.add(s.id);
  for (const s of report.categories.low_quality.unsplash.samples) allIssueIds.add(s.id);
  for (const s of report.categories.low_quality.placeholder.samples) allIssueIds.add(s.id);
  for (const s of report.categories.low_quality.very_short.samples) allIssueIds.add(s.id);
  for (const s of report.categories.invalid_urls.samples) allIssueIds.add(s.id);
  for (const s of report.categories.same_poster_banner.samples) allIssueIds.add(s.id);
  for (const s of report.categories.http_insecure.samples) allIssueIds.add(s.id);

  // To get exact affected count, query all IDs that match ANY issue
  const affectedRows = (await p.$queryRawUnsafe(`
    SELECT DISTINCT id FROM "Show"
    WHERE
      poster_url IS NULL OR TRIM(poster_url) = ''
      OR poster_url LIKE '/%'
      OR poster_url LIKE '%veranimes.net%'
      OR poster_url LIKE '%images.unsplash.com%'
      OR (poster_url IS NOT NULL AND (
        LOWER(poster_url) LIKE '%placeholder%'
        OR LOWER(poster_url) LIKE '%default_poster%'
        OR LOWER(poster_url) LIKE '%no-image%'
        OR LOWER(poster_url) LIKE '%no_image%'
        OR LOWER(poster_url) LIKE '%default.jpg%'
        OR LOWER(poster_url) LIKE '%missing%'
      ))
      OR (poster_url IS NOT NULL AND LENGTH(TRIM(poster_url)) < 10)
      OR (poster_url IS NOT NULL AND TRIM(poster_url) != '' AND poster_url NOT LIKE 'http%' AND poster_url NOT LIKE '/%')
      OR (poster_url IS NOT NULL AND banner_url IS NOT NULL AND TRIM(poster_url) = TRIM(banner_url) AND TRIM(poster_url) != '')
      OR poster_url LIKE 'http://%'
  `)) as any[];
  const affectedCount = affectedRows.length;

  const totalIssues =
    mpCount + ruCount + vaCount + usCount + phCount + vsCount + iuCount + sbCount + hiCount;

  report.summary = {
    total_issues: totalIssues,
    shows_affected: affectedCount,
    healthy_shows: totalShows - affectedCount,
    health_score: Math.round(((totalShows - affectedCount) / totalShows) * 100),
  };

  console.log(`\n${"=".repeat(70)}`);
  console.log(`  RESUMEN`);
  console.log(`${"=".repeat(70)}`);
  console.log(`  Total issues encontrados:     ${totalIssues}`);
  console.log(`  Shows afectados:              ${affectedCount} (${Math.round(affectedCount / totalShows * 100)}%)`);
  console.log(`  Shows saludables:             ${totalShows - affectedCount} (${report.summary.health_score}%)`);
  console.log(`  Health score:                 ${report.summary.health_score}%`);
  console.log(`${"=".repeat(70)}\n`);

  const outPath = join(process.cwd(), "data", "audit-posters.json");
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`Reporte completo guardado en: ${outPath}`);

  await p.$disconnect();
})();
