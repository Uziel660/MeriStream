import { prisma } from "./db";

export interface UnifiedCatalogCounts {
  shows: number;
  media_items: number;
  unique_works: number;
  duplicate_records: number;
}

/** Counts the legacy and canonical projections as one catalog. */
export async function getUnifiedCatalogCounts(): Promise<UnifiedCatalogCounts> {
  const [raw, unique] = await Promise.all([
    prisma.$queryRawUnsafe<Array<{ shows: number; media_items: number }>>(`
      SELECT
        (SELECT COUNT(*)::int FROM "Show") AS shows,
        (SELECT COUNT(*)::int FROM "MediaItem") AS media_items
    `),
    prisma.$queryRawUnsafe<Array<{ unique_works: number }>>(`
      WITH catalog_rows AS (
        SELECT
          CASE
            WHEN "tmdb_id" IS NOT NULL AND "tmdb_id" > 0 THEN
              'tmdb:' ||
              CASE
                WHEN LOWER(COALESCE("category", '')) LIKE '%movie%'
                  OR LOWER(COALESCE("category", '')) LIKE '%pel%'
                  OR LOWER(COALESCE("category", '')) LIKE '%film%' THEN 'movie'
                WHEN LOWER(COALESCE("category", '')) LIKE '%series%'
                  OR LOWER(COALESCE("category", '')) LIKE '%serie%'
                  OR LOWER(COALESCE("category", '')) LIKE '%tv%'
                  OR LOWER(COALESCE("category", '')) LIKE '%show%'
                  OR LOWER(COALESCE("category", '')) LIKE '%anime%' THEN 'tv'
                ELSE LOWER(COALESCE("category", 'unknown'))
              END || ':' || "tmdb_id"::text
            WHEN COALESCE(NULLIF("normalized_title", ''), NULLIF("base_normalized_title", ''), NULLIF("title", '')) IS NOT NULL
              AND "year" IS NOT NULL AND "year" > 0 THEN
              'title:' || LOWER(COALESCE("category", 'unknown')) || ':' ||
              LOWER(COALESCE(NULLIF("normalized_title", ''), NULLIF("base_normalized_title", ''), NULLIF("title", ''))) || ':' || "year"::text
            ELSE 'row:show:' || "id"
          END AS identity_key
        FROM "Show"

        UNION ALL

        SELECT
          CASE
            WHEN "tmdb_id" IS NOT NULL AND "tmdb_id" > 0 THEN
              'tmdb:' ||
              CASE
                WHEN LOWER(COALESCE("kind", '')) LIKE '%movie%'
                  OR LOWER(COALESCE("kind", '')) LIKE '%pel%'
                  OR LOWER(COALESCE("kind", '')) LIKE '%film%' THEN 'movie'
                WHEN LOWER(COALESCE("kind", '')) LIKE '%series%'
                  OR LOWER(COALESCE("kind", '')) LIKE '%serie%'
                  OR LOWER(COALESCE("kind", '')) LIKE '%tv%'
                  OR LOWER(COALESCE("kind", '')) LIKE '%show%'
                  OR LOWER(COALESCE("kind", '')) LIKE '%anime%' THEN 'tv'
                ELSE LOWER(COALESCE("kind", 'unknown'))
              END || ':' || "tmdb_id"::text
            WHEN COALESCE(NULLIF("normalized_title", ''), NULLIF("base_normalized_title", ''), NULLIF("title", '')) IS NOT NULL
              AND "year" IS NOT NULL AND "year" > 0 THEN
              'title:' || LOWER(COALESCE("kind", 'unknown')) || ':' ||
              LOWER(COALESCE(NULLIF("normalized_title", ''), NULLIF("base_normalized_title", ''), NULLIF("title", ''))) || ':' || "year"::text
            ELSE 'row:media:' || "id"
          END AS identity_key
        FROM "MediaItem"
      )
      SELECT COUNT(DISTINCT identity_key)::int AS unique_works
      FROM catalog_rows
    `),
  ]);

  const shows = Number(raw[0]?.shows || 0);
  const mediaItems = Number(raw[0]?.media_items || 0);
  const uniqueWorks = Number(unique[0]?.unique_works || 0);

  return {
    shows,
    media_items: mediaItems,
    unique_works: uniqueWorks,
    duplicate_records: Math.max(0, shows + mediaItems - uniqueWorks),
  };
}
