import { PrismaClient } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";

const p = new PrismaClient({
  datasources: {
    db: {
      url: "postgresql://voidstream:voidstream123@192.168.18.3:5433/voidstream",
    },
  },
});

interface AuditReport {
  timestamp: string;
  summary: Record<string, any>;
  shows_with_zero_episodes: any[];
  episodes_without_source: any[];
  cdn_direct_links: any[];
  episode_numbering_issues: {
    duplicates: any[];
    gaps: any[];
    zero_or_negative: any[];
  };
  source_url_domains: any[];
  mediaitem_show_discrepancy: any[];
  sourcelink_verification: any;
  episode_count_distribution: any[];
}

function printSection(title: string) {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`  ${title}`);
  console.log(`${"=".repeat(70)}`);
}

function printTable(rows: any[], maxRows = 25) {
  if (rows.length === 0) {
    console.log("  (empty)");
    return;
  }
  const keys = Object.keys(rows[0]);
  const widths = keys.map((k) => Math.max(k.length, 12));
  for (const row of rows.slice(0, maxRows)) {
    for (const k of keys) {
      const v = String(row[k] ?? "");
      widths[k] = Math.max(widths[k], Math.min(v.length, 60));
    }
  }

  const header = keys.map((k) => k.padEnd(widths[k])).join(" | ");
  const sep = keys.map((k) => "-".repeat(widths[k])).join("-+-");
  console.log(`  ${header}`);
  console.log(`  ${sep}`);

  for (const row of rows.slice(0, maxRows)) {
    const line = keys
      .map((k) => String(row[k] ?? "").substring(0, 60).padEnd(widths[k]))
      .join(" | ");
    console.log(`  ${line}`);
  }
  if (rows.length > maxRows) {
    console.log(`  ... and ${rows.length - maxRows} more rows`);
  }
}

(async () => {
  await p.$connect();
  const report: AuditReport = {
    timestamp: new Date().toISOString(),
    summary: {},
    shows_with_zero_episodes: [],
    episodes_without_source: [],
    cdn_direct_links: [],
    episode_numbering_issues: { duplicates: [], gaps: [], zero_or_negative: [] },
    source_url_domains: [],
    mediaitem_show_discrepancy: [],
    sourcelink_verification: null,
    episode_count_distribution: [],
  };

  // ── BASE COUNTS ──────────────────────────────────────────────
  const [showCount, epCount, miCount, meCount, slCount] = await Promise.all([
    p.show.count(),
    p.episode.count(),
    p.mediaItem.count(),
    p.mediaEpisode.count(),
    p.sourceLink.count(),
  ]);
  report.summary = {
    shows: showCount,
    episodes: epCount,
    media_items: miCount,
    media_episodes: meCount,
    source_links: slCount,
  };
  printSection("BASE COUNTS");
  console.log(`  Shows:          ${showCount}`);
  console.log(`  Episodes:       ${epCount}`);
  console.log(`  MediaItems:     ${miCount}`);
  console.log(`  MediaEpisodes:  ${meCount}`);
  console.log(`  SourceLinks:    ${slCount}`);

  // ── 1. SHOWS WITH 0 EPISODES ────────────────────────────────
  printSection("1. SHOWS WITH 0 EPISODES");
  const zeroEps = (await p.$queryRawUnsafe(`
    SELECT s.id, s.title, s.category, s.year, s.status, s.created_at
    FROM "Show" s
    LEFT JOIN "Episode" e ON e.show_id = s.id
    WHERE e.id IS NULL
    ORDER BY s.created_at DESC
  `)) as any[];
  report.shows_with_zero_episodes = zeroEps;
  console.log(`  Found: ${zeroEps.length} shows with 0 episodes`);
  printTable(zeroEps, 30);

  // ── 2. EPISODES WITHOUT SOURCE_URL ──────────────────────────
  printSection("2. EPISODES WITHOUT SOURCE_URL (null or empty)");
  const noSource = (await p.$queryRawUnsafe(`
    SELECT e.id, e.title, e.episode_number, s.title AS show_title, s.category
    FROM "Episode" e
    JOIN "Show" s ON s.id = e.show_id
    WHERE e.source_url IS NULL OR TRIM(e.source_url) = ''
    ORDER BY s.title, e.episode_number
    LIMIT 500
  `)) as any[];
  report.episodes_without_source = noSource;
  console.log(`  Found: ${noSource.length} episodes with no source_url`);
  printTable(noSource.slice(0, 30), 30);

  // ── 3. CDN DIRECT LINKS (.m3u8 / .mp4 in URL) ──────────────
  printSection("3. CDN DIRECT LINKS (source_url with .m3u8 or .mp4)");
  const cdnLinks = (await p.$queryRawUnsafe(`
    SELECT e.id, e.title, e.episode_number, s.title AS show_title,
           LEFT(e.source_url, 120) AS source_url
    FROM "Episode" e
    JOIN "Show" s ON s.id = e.show_id
    WHERE (e.source_url ILIKE '%.m3u8%' OR e.source_url ILIKE '%.mp4%')
    ORDER BY s.title, e.episode_number
    LIMIT 500
  `)) as any[];
  report.cdn_direct_links = cdnLinks;
  console.log(`  Found: ${cdnLinks.length} episodes with direct CDN links`);
  printTable(cdnLinks.slice(0, 30), 30);

  // ── 4A. DUPLICATE EPISODE_NUMBER WITHIN SAME SHOW ───────────
  printSection("4A. DUPLICATE EPISODE_NUMBER WITHIN SAME SHOW");
  const duplicates = (await p.$queryRawUnsafe(`
    SELECT s.id AS show_id, s.title, s.category, e.episode_number,
           COUNT(*)::int AS count,
           ARRAY_AGG(LEFT(e.title, 60)) AS titles
    FROM "Episode" e
    JOIN "Show" s ON s.id = e.show_id
    GROUP BY s.id, s.title, s.category, e.episode_number
    HAVING COUNT(*) > 1
    ORDER BY count DESC, s.title
  `)) as any[];
  report.episode_numbering_issues.duplicates = duplicates;
  console.log(`  Found: ${duplicates.length} duplicate episode_number groups`);
  printTable(duplicates, 30);

  // ── 4B. EPISODE NUMBERING GAPS ──────────────────────────────
  printSection("4B. EPISODE NUMBERING GAPS (skipped sequence)");
  // Find shows where episode numbers skip
  const allEps = (await p.$queryRawUnsafe(`
    SELECT e.show_id, e.episode_number, s.title, s.category
    FROM "Episode" e
    JOIN "Show" s ON s.id = e.show_id
    WHERE e.episode_number >= 1
    ORDER BY e.show_id, e.episode_number
  `)) as any[];

  const epsByShow = new Map<string, { title: string; category: string; numbers: number[] }>();
  for (const row of allEps) {
    const existing = epsByShow.get(row.show_id);
    if (existing) {
      existing.numbers.push(Number(row.episode_number));
    } else {
      epsByShow.set(row.show_id, {
        title: row.title,
        category: row.category,
        numbers: [Number(row.episode_number)],
      });
    }
  }

  const gapShows: any[] = [];
  for (const [showId, data] of epsByShow) {
    const sorted = [...new Set(data.numbers)].sort((a, b) => a - b);
    const min = Math.min(...sorted);
    const max = Math.max(...sorted);
    const expected = new Set<number>();
    for (let i = Math.floor(min); i <= Math.floor(max); i++) expected.add(i);
    const missing = [...expected].filter((n) => !sorted.includes(n));
    if (missing.length > 0 && sorted.length > 1) {
      gapShows.push({
        show_id: showId,
        title: data.title,
        category: data.category,
        ep_count: sorted.length,
        range: `${Math.floor(min)}-${Math.floor(max)}`,
        gaps_count: missing.length,
        sample_gaps: missing.slice(0, 10).join(", "),
      });
    }
  }
  gapShows.sort((a, b) => b.gaps_count - a.gaps_count);
  report.episode_numbering_issues.gaps = gapShows;
  console.log(`  Found: ${gapShows.length} shows with episode numbering gaps`);
  printTable(gapShows, 30);

  // ── 4C. EPISODE NUMBER 0 OR NEGATIVE ────────────────────────
  printSection("4C. EPISODE NUMBER 0 OR NEGATIVE");
  const zeroNeg = (await p.$queryRawUnsafe(`
    SELECT e.id, e.title, e.episode_number, s.title AS show_title, s.category
    FROM "Episode" e
    JOIN "Show" s ON s.id = e.show_id
    WHERE e.episode_number <= 0
    ORDER BY e.episode_number, s.title
  `)) as any[];
  report.episode_numbering_issues.zero_or_negative = zeroNeg;
  console.log(`  Found: ${zeroNeg.length} episodes with number <= 0`);
  printTable(zeroNeg, 30);

  // ── 5. SOURCE URL BY DOMAIN ─────────────────────────────────
  printSection("5. SOURCE URL DOMAIN DISTRIBUTION");
  const domains = (await p.$queryRawUnsafe(`
    SELECT
      CASE
        WHEN source_url ~ '^https?://[^/]+' THEN (regexp_match(source_url, '^https?://([^/:]+)'))[1]
        ELSE 'invalid/no-url'
      END AS domain,
      COUNT(*)::int AS episode_count,
      COUNT(DISTINCT show_id)::int AS show_count
    FROM "Episode"
    WHERE source_url IS NOT NULL AND source_url != ''
    GROUP BY domain
    ORDER BY episode_count DESC
  `)) as any[];
  report.source_url_domains = domains;
  printTable(domains, 50);

  // ── 6. MEDIAITEM vs SHOW DISCREPANCY ────────────────────────
  printSection("6. MEDIAITEM vs SHOW DISCREPANCY");
  // MediaItems that have MediaEpisodes but no matching Show (by normalized_title)
  const miWithoutShow = (await p.$queryRawUnsafe(`
    SELECT mi.id, mi.title, mi.normalized_title, mi.kind, mi.year,
           COUNT(me.id)::int AS media_episodes
    FROM "MediaItem" mi
    INNER JOIN "MediaEpisode" me ON me.media_item_id = mi.id
    LEFT JOIN "Show" s ON s.normalized_title = mi.normalized_title
    WHERE s.id IS NULL
    GROUP BY mi.id, mi.title, mi.normalized_title, mi.kind, mi.year
    ORDER BY media_episodes DESC
  `)) as any[];
  report.mediaitem_show_discrepancy = miWithoutShow;
  console.log(`  MediaItems with episodes but NO matching Show: ${miWithoutShow.length}`);
  printTable(miWithoutShow, 30);

  // ── 7. SOURCELINK VERIFICATION STATUS ───────────────────────
  printSection("7. SOURCELINK VERIFICATION STATUS");
  const slStats = (await p.$queryRawUnsafe(`
    SELECT
      is_verified,
      COUNT(*)::int AS total,
      COUNT(DISTINCT media_episode_id)::int AS unique_episodes,
      COUNT(DISTINCT source_site)::int AS unique_sites,
      ARRAY_AGG(DISTINCT source_site) AS sites
    FROM "SourceLink"
    GROUP BY is_verified
    ORDER BY is_verified DESC
  `)) as any[];
  report.sourcelink_verification = slStats;
  for (const row of slStats) {
    console.log(`\n  is_verified=${row.is_verified}:`);
    console.log(`    Total links:       ${row.total}`);
    console.log(`    Unique episodes:   ${row.unique_episodes}`);
    console.log(`    Unique sites:      ${row.unique_sites}`);
    console.log(`    Sites:             ${(row.sites || []).join(", ")}`);
  }

  // Top source sites
  const topSites = (await p.$queryRawUnsafe(`
    SELECT source_site, is_verified,
           COUNT(*)::int AS link_count,
           COUNT(DISTINCT media_episode_id)::int AS episode_count
    FROM "SourceLink"
    GROUP BY source_site, is_verified
    ORDER BY link_count DESC
    LIMIT 20
  `)) as any[];
  console.log(`\n  Top Source Sites:`);
  printTable(topSites, 20);

  // ── 8. EPISODE COUNT PER SHOW DISTRIBUTION ──────────────────
  printSection("8. EPISODE COUNT PER SHOW DISTRIBUTION (Histogram)");
  const rawCounts = (await p.$queryRawUnsafe(`
    SELECT
      s.id, s.title, s.category,
      COUNT(e.id)::int AS ep_count
    FROM "Show" s
    LEFT JOIN "Episode" e ON e.show_id = s.id
    GROUP BY s.id, s.title, s.category
  `)) as any[];

  const buckets: Record<string, number> = {
    "0 eps": 0,
    "1 eps": 0,
    "2-5 eps": 0,
    "6-10 eps": 0,
    "11-25 eps": 0,
    "26-50 eps": 0,
    "51-100 eps": 0,
    "100+ eps": 0,
  };

  const epCounts: { title: string; category: string; ep_count: number }[] = [];
  for (const r of rawCounts) {
    const c = r.ep_count;
    epCounts.push({ title: r.title, category: r.category, ep_count: c });
    if (c === 0) buckets["0 eps"]++;
    else if (c === 1) buckets["1 eps"]++;
    else if (c <= 5) buckets["2-5 eps"]++;
    else if (c <= 10) buckets["6-10 eps"]++;
    else if (c <= 25) buckets["11-25 eps"]++;
    else if (c <= 50) buckets["26-50 eps"]++;
    else if (c <= 100) buckets["51-100 eps"]++;
    else buckets["100+ eps"]++;
  }

  const distribution = Object.entries(buckets).map(([range, count]) => ({
    range,
    shows: count,
    pct: rawCounts.length > 0 ? `${((count / rawCounts.length) * 100).toFixed(1)}%` : "0%",
  }));
  report.episode_count_distribution = distribution;

  console.log(`  Total shows: ${rawCounts.length}\n`);
  const maxCount = Math.max(...Object.values(buckets));
  for (const { range, shows, pct } of distribution) {
    const bar = maxCount > 0 ? "█".repeat(Math.round((shows / maxCount) * 40)) : "";
    console.log(`  ${range.padEnd(12)} │ ${String(shows).padStart(5)} (${pct.padStart(6)}) ${bar}`);
  }

  // Top 10 and bottom 10 by episode count
  epCounts.sort((a, b) => b.ep_count - a.ep_count);
  console.log(`\n  Top 10 shows by episode count:`);
  printTable(epCounts.slice(0, 10), 10);
  console.log(`\n  Bottom 10 shows by episode count:`);
  printTable(epCounts.slice(-10), 10);

  // ── SAVE REPORT ─────────────────────────────────────────────
  const dataDir = path.join(process.cwd(), "data");
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const reportPath = path.join(dataDir, "audit-episodes.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n${"=".repeat(70)}`);
  console.log(`  FULL REPORT SAVED → ${reportPath}`);
  console.log(`${"=".repeat(70)}\n`);

  await p.$disconnect();
})();
