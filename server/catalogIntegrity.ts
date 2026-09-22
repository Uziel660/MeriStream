/** Utilities shared by every catalog adapter and the catalog worker.
 *
 * Catalog pages are allowed to contain the same work more than once, but a
 * title is never a safe deduplication key: different years, seasons and cuts
 * can legitimately share a title. URLs are canonicalized only for tracking
 * pagination and repeated cards; the original URL remains persisted.
 */

export interface CatalogItemLike {
  title: string;
  url: string;
}

const TRACKING_PARAMETERS = /^(utm_|fbclid$|gclid$|ref$|referrer$)/i;

export function canonicalCatalogUrl(rawUrl: unknown): string {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return "";
  try {
    const url = new URL(rawUrl.trim());
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMETERS.test(key)) url.searchParams.delete(key);
    }
    const path = url.pathname.replace(/\/{2,}/g, "/");
    url.pathname = path.length > 1 ? path.replace(/\/$/, "") : "/";
    return url.toString();
  } catch {
    return rawUrl.trim();
  }
}

/** Deduplicate cards by canonical URL while filling missing metadata. */
export function dedupeCatalogItems<T extends CatalogItemLike>(items: readonly T[] | null | undefined): T[] {
  const byUrl = new Map<string, T>();
  for (const item of items || []) {
    if (!item || typeof item.url !== "string" || !item.url.trim()) continue;
    const key = canonicalCatalogUrl(item.url);
    const previous = byUrl.get(key);
    if (!previous) {
      byUrl.set(key, item);
      continue;
    }
    const merged = { ...previous } as T;
    for (const [field, value] of Object.entries(item)) {
      const oldValue = (merged as Record<string, unknown>)[field];
      if ((oldValue === undefined || oldValue === null || oldValue === "") && value !== undefined && value !== null && value !== "") {
        (merged as Record<string, unknown>)[field] = value;
      }
    }
    byUrl.set(key, merged);
  }
  return [...byUrl.values()];
}

export function catalogPageFingerprint(items: readonly CatalogItemLike[] | null | undefined): string {
  return dedupeCatalogItems(items)
    .map((item) => canonicalCatalogUrl(item.url))
    .sort()
    .join("|");
}

export function isRepeatedCatalogPage(
  items: readonly CatalogItemLike[] | null | undefined,
  previousFingerprint?: string,
): boolean {
  const fingerprint = catalogPageFingerprint(items);
  return Boolean(fingerprint) && fingerprint === previousFingerprint;
}

/**
 * Descarta URLs que corresponden a índices, directorios, o páginas de catálogo/serie
 * que jamás deben persistirse como streams o reproducirse como episodios.
 */
export function isInvalidCatalogSource(url: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname.toLowerCase();
    if (/\/page\/\d+(?:\/|$)/i.test(pathname)) return true;
    for (const key of ["page", "paged"]) {
      const value = parsed.searchParams.get(key);
      if (value && /^\d+$/.test(value)) return true;
    }
    const host = parsed.hostname.toLowerCase();
    if (
      /^\/$/.test(pathname) ||
      /\/(?:catalogo|peliculas|series|estrenos|genero|category|categoria|animes)\/?$/i.test(pathname)
    ) {
      return true;
    }

    const isDirectMedia = /\.(m3u8|mpd|mp4|webm|mkv)(\?|#|$)/i.test(pathname);
    if (!isDirectMedia) {
      const hasEpisodeOrMedia =
        /\d+x\d+|\/(?:episodio|capitulo|episode|ep)-\d+|\/(?:temporada|season)-\d+|\/\d+\/\d+|\/\d+\/?$/i.test(pathname) ||
        /\b(?:1x01|capitulo|episodio)\b/i.test(pathname);

      // Tioplus y otros: /serie/<slug> o /series/<slug> sin /season/.../episode/... es overview de serie
      if (/^\/series?\/[^\/]+\/?$/i.test(pathname) && !hasEpisodeOrMedia) {
        return true;
      }
      // Gnula: /ver/<slug>/ es overview de la serie (los episodios son /<slug>-1x01/)
      if (host.includes("gnula") && /^\/ver\/[^\/]+\/?$/i.test(pathname) && !hasEpisodeOrMedia) {
        return true;
      }
      // AnimeFLV / TioAnime / LatAnime: /anime/<slug> es ficha del show, no episodio (/ver/<slug>-1)
      if (/^\/anime\/[^\/]+\/?$/i.test(pathname) && !hasEpisodeOrMedia) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Ejecuta una auditoría y saneamiento completo de PostgreSQL eliminando
 * landing pages o páginas de catálogo general asociadas erróneamente a episodios.
 */
export async function sanitizeCatalogLandingPages(): Promise<{ totalCleaned: number; details: Record<string, number> }> {
  const { prisma } = await import("./db");

  // 1. Anime /anime/: purgar redundantes y convertir huérfanos a /ver/
  const deleteAnime = await prisma.$executeRawUnsafe(`
    DELETE FROM "SourceLink"
    WHERE url LIKE '%/anime/%'
      AND media_episode_id IN (
        SELECT media_episode_id
        FROM "SourceLink"
        WHERE url NOT LIKE '%/anime/%'
      );
  `);

  const orphanAnime = await prisma.sourceLink.findMany({
    where: { url: { contains: "/anime/" } },
    include: { media_episode: true },
  });
  let animeConverted = 0;
  for (const link of orphanAnime) {
    const epNum = Math.round(link.media_episode.episode_number);
    let newUrl = link.url;
    if (link.url.includes("latanime.org/anime/")) {
      const slug = link.url.split("/anime/")[1]?.split(/[\/?#]/)[0];
      if (slug) newUrl = `https://latanime.org/ver/${slug}-episodio-${epNum}`;
    } else if (link.url.includes("tioanime.com/anime/")) {
      const slug = link.url.split("/anime/")[1]?.split(/[\/?#]/)[0];
      if (slug) newUrl = `https://tioanime.com/ver/${slug}-${epNum}`;
    } else if (link.url.includes("animeflv.net/anime/") || link.url.includes("animeflv.or.at/anime/")) {
      const slug = link.url.split("/anime/")[1]?.split(/[\/?#]/)[0];
      if (slug) newUrl = `https://www3.animeflv.net/ver/${slug}-${epNum}`;
    }
    if (newUrl !== link.url) {
      await prisma.sourceLink.update({
        where: { id: link.id },
        data: { url: newUrl, canonical_locator: newUrl, link_type: "page" },
      });
      animeConverted++;
    }
  }

  // 2. Tioplus /serie/: purgar redundantes y convertir huérfanos a /season/X/episode/Y
  const deleteTio = await prisma.$executeRawUnsafe(`
    DELETE FROM "SourceLink"
    WHERE (url LIKE '%tioplus.app/serie/%' OR url LIKE '%tioplus.app/series/%')
      AND url NOT LIKE '%/episode/%'
      AND media_episode_id IN (
        SELECT media_episode_id
        FROM "SourceLink"
        WHERE (url NOT LIKE '%tioplus.app/serie/%' AND url NOT LIKE '%tioplus.app/series/%')
          OR url LIKE '%/episode/%'
      );
  `);

  const orphanTio = await prisma.sourceLink.findMany({
    where: {
      url: { contains: "tioplus.app/serie/" },
      NOT: { url: { contains: "/episode/" } },
    },
    include: { media_episode: true },
  });
  let tioConverted = 0;
  for (const link of orphanTio) {
    const seasonNum = Math.max(1, Math.round(link.media_episode.season_number));
    const epNum = Math.max(1, Math.round(link.media_episode.episode_number));
    try {
      const parsed = new URL(link.url);
      const parts = parsed.pathname.split("/").filter(Boolean);
      const prefix = ["serie", "anime", "series"].includes(parts[0]) ? parts[0] : "serie";
      const slug = parts[1];
      if (slug) {
        const newUrl = `https://tioplus.app/${prefix}/${slug}/season/${seasonNum}/episode/${epNum}`;
        await prisma.sourceLink.update({
          where: { id: link.id },
          data: { url: newUrl, canonical_locator: newUrl, link_type: "page" },
        });
        tioConverted++;
      }
    } catch {}
  }

  // 3. GNULA /ver/<slug> en series y animes
  const deleteGnula = await prisma.$executeRawUnsafe(`
    DELETE FROM "SourceLink"
    WHERE id IN (
      SELECT sl.id
      FROM "SourceLink" sl
      JOIN "MediaEpisode" me ON me.id = sl.media_episode_id
      JOIN "MediaItem" mi ON mi.id = me.media_item_id
      WHERE mi.kind IN ('series', 'anime')
        AND sl.url LIKE '%gnulahd.nu/ver/%'
        AND sl.url NOT LIKE '%-1x%'
        AND sl.url NOT LIKE '%-2x%'
        AND sl.url NOT LIKE '%-3x%'
        AND sl.url NOT LIKE '%-4x%'
        AND sl.url NOT LIKE '%-5x%'
        AND sl.url NOT LIKE '%-6x%'
        AND sl.url NOT LIKE '%-7x%'
        AND sl.url NOT LIKE '%-8x%'
        AND sl.url NOT LIKE '%-9x%'
        AND sl.url NOT LIKE '%/episodio-%'
    );
  `);

  // 4. Cinecalidad: purgar redundantes y convertir huérfanos a /ver-el-episodio/
  const deleteCinecalidad = await prisma.$executeRawUnsafe(`
    DELETE FROM "SourceLink"
    WHERE url LIKE '%cinecalidad.am/ver-serie/%'
      AND media_episode_id IN (
        SELECT media_episode_id
        FROM "SourceLink"
        WHERE url NOT LIKE '%cinecalidad.am/ver-serie/%'
      );
  `);

  const orphanCinecalidad = await prisma.sourceLink.findMany({
    where: { url: { contains: "cinecalidad.am/ver-serie/" } },
    include: { media_episode: true },
  });
  let cinecalidadConverted = 0;
  for (const link of orphanCinecalidad) {
    const seasonNum = Math.max(1, Math.round(link.media_episode.season_number));
    const epNum = Math.max(1, Math.round(link.media_episode.episode_number));
    try {
      const parsed = new URL(link.url);
      const slug = parsed.pathname.replace(/^\/ver-serie\//, "").replace(/\/+$/, "");
      if (slug) {
        const epStr = epNum < 10 ? `0${epNum}` : `${epNum}`;
        const newUrl = `https://www.cinecalidad.am/ver-el-episodio/${slug}-${seasonNum}x${epStr}/`;
        await prisma.sourceLink.update({
          where: { id: link.id },
          data: { url: newUrl, canonical_locator: newUrl, link_type: "page" },
        });
        cinecalidadConverted++;
      }
    } catch {}
  }

  // 5. LaMovie: purgar redundantes y convertir huérfanos a /episodio/
  const deleteLaMovie = await prisma.$executeRawUnsafe(`
    DELETE FROM "SourceLink"
    WHERE id IN (
      SELECT sl.id
      FROM "SourceLink" sl
      JOIN "MediaEpisode" me ON me.id = sl.media_episode_id
      JOIN "MediaItem" mi ON mi.id = me.media_item_id
      WHERE mi.kind IN ('series', 'anime')
        AND sl.url LIKE '%lamovie.org/series/%'
        AND sl.media_episode_id IN (
          SELECT media_episode_id
          FROM "SourceLink"
          WHERE url NOT LIKE '%lamovie.org/series/%'
        )
    );
  `);

  const orphanLaMovie = await prisma.sourceLink.findMany({
    where: {
      url: { contains: "lamovie.org/series/" },
      media_episode: { media_item: { kind: { in: ["series", "anime"] } } },
    },
    include: { media_episode: true },
  });
  let laMovieConverted = 0;
  for (const link of orphanLaMovie) {
    const seasonNum = Math.max(1, Math.round(link.media_episode.season_number));
    const epNum = Math.max(1, Math.round(link.media_episode.episode_number));
    try {
      const parsed = new URL(link.url);
      const slug = parsed.pathname.replace(/^\/series\//, "").replace(/\/+$/, "").replace(/-\d{4}$/, "");
      if (slug) {
        const newUrl = `https://lamovie.org/episodio/${slug}-temporada-${seasonNum}-episodio-${epNum}/`;
        await prisma.sourceLink.update({
          where: { id: link.id },
          data: { url: newUrl, canonical_locator: newUrl, link_type: "page" },
        });
        laMovieConverted++;
      }
    } catch {}
  }

  // 6. Doramasflix /doramas/
  const deleteDoramas = await prisma.$executeRawUnsafe(`
    DELETE FROM "SourceLink"
    WHERE id IN (
      SELECT sl.id
      FROM "SourceLink" sl
      JOIN "MediaEpisode" me ON me.id = sl.media_episode_id
      JOIN "MediaItem" mi ON mi.id = me.media_item_id
      WHERE mi.kind IN ('series', 'anime')
        AND sl.url LIKE '%doramasflix.io/doramas/%'
    );
  `);

  const totalPurged =
    Number(deleteAnime || 0) +
    Number(deleteTio || 0) +
    Number(deleteGnula || 0) +
    Number(deleteCinecalidad || 0) +
    Number(deleteLaMovie || 0) +
    Number(deleteDoramas || 0);

  const totalConverted =
    animeConverted + tioConverted + cinecalidadConverted + laMovieConverted;

  const languageFixes = await normalizeProviderLanguages();

  return {
    totalCleaned: totalPurged + totalConverted,
    details: {
      purged_anime: Number(deleteAnime || 0),
      converted_anime: animeConverted,
      purged_tioplus: Number(deleteTio || 0),
      converted_tioplus: tioConverted,
      purged_gnula: Number(deleteGnula || 0),
      purged_cinecalidad: Number(deleteCinecalidad || 0),
      converted_cinecalidad: cinecalidadConverted,
      purged_lamovie: Number(deleteLaMovie || 0),
      converted_lamovie: laMovieConverted,
      purged_doramasflix: Number(deleteDoramas || 0),
      total_purged: totalPurged,
      total_repaired: totalConverted,
      language_fixes: languageFixes,
    },
  };
}

export async function normalizeProviderLanguages(): Promise<{
  latanime_latino: number;
  latanime_castellano: number;
  latanime_catalan: number;
  latanime_sub: number;
}> {
  const { prisma } = await import("./db");

  // 1. LatAnime Latino
  const lat = await prisma.$executeRawUnsafe(`
    UPDATE "SourceLink"
    SET audio_language = 'es-419',
        language = 'dub'
    WHERE (source_site = 'latanime' OR url LIKE '%latanime.org%')
      AND (url ILIKE '%latino%' OR canonical_locator ILIKE '%latino%')
      AND (audio_language IS DISTINCT FROM 'es-419' OR language IS DISTINCT FROM 'dub');
  `);

  // 2. LatAnime Castellano
  const cas = await prisma.$executeRawUnsafe(`
    UPDATE "SourceLink"
    SET audio_language = 'es-ES',
        language = 'dub'
    WHERE (source_site = 'latanime' OR url LIKE '%latanime.org%')
      AND (url ILIKE '%castellano%' OR canonical_locator ILIKE '%castellano%')
      AND (audio_language IS DISTINCT FROM 'es-ES' OR language IS DISTINCT FROM 'dub');
  `);

  // 3. LatAnime Catalan
  const cat = await prisma.$executeRawUnsafe(`
    UPDATE "SourceLink"
    SET audio_language = 'ca',
        language = 'dub'
    WHERE (source_site = 'latanime' OR url LIKE '%latanime.org%')
      AND (url ILIKE '%catalan%' OR url ILIKE '%catala%' OR canonical_locator ILIKE '%catalan%')
      AND (audio_language IS DISTINCT FROM 'ca' OR language IS DISTINCT FROM 'dub');
  `);

  // 4. LatAnime Subtitulado (Japanese audio with Spanish subs)
  const sub = await prisma.$executeRawUnsafe(`
    UPDATE "SourceLink"
    SET audio_language = 'ja',
        subtitle_language = 'es',
        language = 'sub'
    WHERE (source_site = 'latanime' OR url LIKE '%latanime.org%')
      AND url NOT ILIKE '%latino%'
      AND url NOT ILIKE '%castellano%'
      AND url NOT ILIKE '%catalan%'
      AND url NOT ILIKE '%catala%'
      AND (audio_language IS DISTINCT FROM 'ja' OR subtitle_language IS DISTINCT FROM 'es' OR language IS DISTINCT FROM 'sub');
  `);

  return {
    latanime_latino: Number(lat || 0),
    latanime_castellano: Number(cas || 0),
    latanime_catalan: Number(cat || 0),
    latanime_sub: Number(sub || 0),
  };
}


