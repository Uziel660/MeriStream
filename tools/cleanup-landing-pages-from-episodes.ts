// tools/cleanup-landing-pages-from-episodes.ts
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function cleanupLandingPages() {
  console.log("[CleanupLandingPages] ========================================================");
  console.log("[CleanupLandingPages] Iniciando purga arquitectónica de landing pages en episodios...");
  console.log("[CleanupLandingPages] ========================================================");

  // 1. ANIME: Eliminar SourceLinks redundantes con /anime/ en episodios que ya tienen otros enlaces reales
  console.log("[CleanupLandingPages] 1. Limpiando /anime/...");
  const deleteAnimeRedundant = await prisma.$executeRawUnsafe(`
    DELETE FROM "SourceLink"
    WHERE url LIKE '%/anime/%'
      AND media_episode_id IN (
        SELECT media_episode_id
        FROM "SourceLink"
        WHERE url NOT LIKE '%/anime/%'
      );
  `);
  console.log(`[CleanupLandingPages] SourceLinks redundantes con /anime/ eliminados: ${deleteAnimeRedundant}`);

  // Convertir SourceLinks huérfanos con /anime/ a URLs reales de episodio
  const orphanAnimeLinks = await prisma.sourceLink.findMany({
    where: { url: { contains: "/anime/" } },
    include: { media_episode: true },
  });
  let animeConverted = 0;
  for (const link of orphanAnimeLinks) {
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
  console.log(`[CleanupLandingPages] SourceLinks huérfanos con /anime/ convertidos: ${animeConverted}`);

  // 2. TIOPLUS: Eliminar SourceLinks con /serie/ o /series/ que son landing pages (sin /season/ ni /episode/)
  console.log("\n[CleanupLandingPages] 2. Procesando Tioplus (/serie/ y /series/)...");
  const deleteTioRedundant = await prisma.$executeRawUnsafe(`
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
  console.log(`[CleanupLandingPages] SourceLinks de Tioplus redundantes eliminados: ${deleteTioRedundant}`);

  // Para los huérfanos restantes de Tioplus, convertirlos a la URL real del episodio:
  // https://tioplus.app/serie/{slug}/season/{season}/episode/{episode}
  const orphanTioLinks = await prisma.sourceLink.findMany({
    where: {
      url: { contains: "tioplus.app/serie/" },
      NOT: { url: { contains: "/episode/" } },
    },
    include: { media_episode: true },
  });
  console.log(`[CleanupLandingPages] SourceLinks huérfanos de Tioplus para convertir: ${orphanTioLinks.length}`);
  let tioConverted = 0;
  for (const link of orphanTioLinks) {
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
    } catch {
      // Ignorar URLs inválidas
    }
  }
  console.log(`[CleanupLandingPages] SourceLinks huérfanos de Tioplus convertidos a URLs reales: ${tioConverted}`);

  // 3. GNULA: Eliminar landing pages de series/anime (/ver/<slug>/) asociadas a episodios
  console.log("\n[CleanupLandingPages] 3. Procesando GNULA (series y anime)...");
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
  console.log(`[CleanupLandingPages] SourceLinks de series/anime GNULA eliminados: ${deleteGnula}`);

  // 4. CINECALIDAD: Eliminar /ver-serie/ redundantes y convertir huérfanos a /ver-el-episodio/{slug}-{s}x{e}/
  console.log("\n[CleanupLandingPages] 4. Procesando Cinecalidad (/ver-serie/)...");
  const deleteCinecalidadRedundant = await prisma.$executeRawUnsafe(`
    DELETE FROM "SourceLink"
    WHERE url LIKE '%cinecalidad.am/ver-serie/%'
      AND media_episode_id IN (
        SELECT media_episode_id
        FROM "SourceLink"
        WHERE url NOT LIKE '%cinecalidad.am/ver-serie/%'
      );
  `);
  console.log(`[CleanupLandingPages] SourceLinks redundantes de Cinecalidad eliminados: ${deleteCinecalidadRedundant}`);

  const orphanCinecalidadLinks = await prisma.sourceLink.findMany({
    where: { url: { contains: "cinecalidad.am/ver-serie/" } },
    include: { media_episode: true },
  });
  console.log(`[CleanupLandingPages] SourceLinks huérfanos de Cinecalidad para convertir: ${orphanCinecalidadLinks.length}`);
  let cineConverted = 0;
  for (const link of orphanCinecalidadLinks) {
    const seasonNum = Math.max(1, Math.round(link.media_episode.season_number));
    const epNum = Math.max(1, Math.round(link.media_episode.episode_number));
    try {
      const parsed = new URL(link.url);
      const slug = parsed.pathname.replace(/^\/ver-serie\//, "").replace(/\/+$/, "");
      if (slug) {
        const newUrl = `https://www.cinecalidad.am/ver-el-episodio/${slug}-${seasonNum}x${epNum}/`;
        await prisma.sourceLink.update({
          where: { id: link.id },
          data: { url: newUrl, canonical_locator: newUrl, link_type: "page" },
        });
        cineConverted++;
      }
    } catch {}
  }
  console.log(`[CleanupLandingPages] SourceLinks huérfanos de Cinecalidad convertidos a episodios reales: ${cineConverted}`);

  // 5. LAMOVIE: Eliminar /series/ redundantes y convertir huérfanos a /episodio/{baseSlug}-temporada-{s}-episodio-{e}/
  console.log("\n[CleanupLandingPages] 5. Procesando LaMovie (/series/)...");
  const deleteLaMovieRedundant = await prisma.$executeRawUnsafe(`
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
  console.log(`[CleanupLandingPages] SourceLinks redundantes de LaMovie eliminados: ${deleteLaMovieRedundant}`);

  const orphanLaMovieLinks = await prisma.sourceLink.findMany({
    where: {
      url: { contains: "lamovie.org/series/" },
      media_episode: {
        media_item: { kind: { in: ["series", "anime"] } },
      },
    },
    include: { media_episode: true },
  });
  console.log(`[CleanupLandingPages] SourceLinks huérfanos de LaMovie para convertir: ${orphanLaMovieLinks.length}`);
  let laMovieConverted = 0;
  for (const link of orphanLaMovieLinks) {
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
  console.log(`[CleanupLandingPages] SourceLinks huérfanos de LaMovie convertidos a episodios reales: ${laMovieConverted}`);

  // 6. DORAMASFLIX: Eliminar /doramas/ redundantes en episodios
  console.log("\n[CleanupLandingPages] 6. Procesando Doramasflix (/doramas/)...");
  const deleteDoramasRedundant = await prisma.$executeRawUnsafe(`
    DELETE FROM "SourceLink"
    WHERE id IN (
      SELECT sl.id
      FROM "SourceLink" sl
      JOIN "MediaEpisode" me ON me.id = sl.media_episode_id
      JOIN "MediaItem" mi ON mi.id = me.media_item_id
      WHERE mi.kind IN ('series', 'anime')
        AND sl.url LIKE '%doramasflix.io/doramas/%'
        AND sl.media_episode_id IN (
          SELECT media_episode_id
          FROM "SourceLink"
          WHERE url NOT LIKE '%doramasflix.io/doramas/%'
        )
    );
  `);
  console.log(`[CleanupLandingPages] SourceLinks redundantes de Doramasflix eliminados: ${deleteDoramasRedundant}`);

  const deleteDoramasRemaining = await prisma.$executeRawUnsafe(`
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
  console.log(`[CleanupLandingPages] SourceLinks huérfanos residuales de Doramasflix eliminados: ${deleteDoramasRemaining}`);

  // 7. Esquema legacy Episode.source_url
  console.log("\n[CleanupLandingPages] 7. Limpiando esquema legacy Episode.source_url...");
  const legacyEpisodes = await prisma.episode.findMany({
    where: { source_url: { contains: "/anime/" } },
    select: { id: true, episode_number: true, source_url: true },
  });
  let legacyFixed = 0;
  for (const ep of legacyEpisodes) {
    const epNum = Math.round(ep.episode_number);
    let newUrl = ep.source_url;
    if (ep.source_url.includes("latanime.org/anime/")) {
      const slug = ep.source_url.split("/anime/")[1]?.split(/[\/?#]/)[0];
      if (slug) newUrl = `https://latanime.org/ver/${slug}-episodio-${epNum}`;
    } else if (ep.source_url.includes("tioanime.com/anime/")) {
      const slug = ep.source_url.split("/anime/")[1]?.split(/[\/?#]/)[0];
      if (slug) newUrl = `https://tioanime.com/ver/${slug}-${epNum}`;
    } else if (ep.source_url.includes("animeflv.net/anime/")) {
      const slug = ep.source_url.split("/anime/")[1]?.split(/[\/?#]/)[0];
      if (slug) newUrl = `https://www3.animeflv.net/ver/${slug}-${epNum}`;
    }
    if (newUrl !== ep.source_url) {
      await prisma.episode.update({
        where: { id: ep.id },
        data: { source_url: newUrl },
      });
      legacyFixed++;
    }
  }
  console.log(`[CleanupLandingPages] Episodios legacy corregidos a /ver/: ${legacyFixed}`);

  // 8. Verificación final
  console.log("\n[CleanupLandingPages] 8. Verificación final de integridad...");
  const [resTio]: any = await prisma.$queryRawUnsafe(`
    SELECT count(*)::int as c FROM "SourceLink" WHERE url LIKE '%tioplus.app/serie/%' AND url NOT LIKE '%/episode/%'
  `);
  const [resGnula]: any = await prisma.$queryRawUnsafe(`
    SELECT count(*)::int as c FROM "SourceLink" sl
    JOIN "MediaEpisode" me ON me.id = sl.media_episode_id
    JOIN "MediaItem" mi ON mi.id = me.media_item_id
    WHERE mi.kind IN ('series', 'anime')
      AND sl.url LIKE '%gnulahd.nu/ver/%'
      AND sl.url NOT LIKE '%-1x%' AND sl.url NOT LIKE '%-2x%' AND sl.url NOT LIKE '%-3x%' AND sl.url NOT LIKE '%-4x%' AND sl.url NOT LIKE '%-5x%'
  `);
  const [resAnime]: any = await prisma.$queryRawUnsafe(`
    SELECT count(*)::int as c FROM "SourceLink" WHERE url LIKE '%/anime/%'
  `);
  const [resCinecalidad]: any = await prisma.$queryRawUnsafe(`
    SELECT count(*)::int as c FROM "SourceLink" WHERE url LIKE '%cinecalidad.am/ver-serie/%'
  `);
  const [resLaMovie]: any = await prisma.$queryRawUnsafe(`
    SELECT count(*)::int as c FROM "SourceLink" sl
    JOIN "MediaEpisode" me ON me.id = sl.media_episode_id
    JOIN "MediaItem" mi ON mi.id = me.media_item_id
    WHERE mi.kind IN ('series', 'anime') AND sl.url LIKE '%lamovie.org/series/%'
  `);
  const [resDoramas]: any = await prisma.$queryRawUnsafe(`
    SELECT count(*)::int as c FROM "SourceLink" sl
    JOIN "MediaEpisode" me ON me.id = sl.media_episode_id
    JOIN "MediaItem" mi ON mi.id = me.media_item_id
    WHERE mi.kind IN ('series', 'anime') AND sl.url LIKE '%doramasflix.io/doramas/%'
  `);

  console.log(`[CleanupLandingPages] Tioplus landing restantes en episodios: ${resTio?.c ?? 0}`);
  console.log(`[CleanupLandingPages] Gnula series landing restantes en episodios: ${resGnula?.c ?? 0}`);
  console.log(`[CleanupLandingPages] /anime/ landing restantes en episodios: ${resAnime?.c ?? 0}`);
  console.log(`[CleanupLandingPages] Cinecalidad landing restantes en episodios: ${resCinecalidad?.c ?? 0}`);
  console.log(`[CleanupLandingPages] LaMovie landing restantes en episodios: ${resLaMovie?.c ?? 0}`);
  console.log(`[CleanupLandingPages] Doramasflix landing restantes en episodios: ${resDoramas?.c ?? 0}`);
  console.log("[CleanupLandingPages] ¡Purga completada exitosamente!");

  await prisma.$disconnect();
}

cleanupLandingPages().catch((e) => {
  console.error("[CleanupLandingPages] Error durante la purga:", e);
  process.exit(1);
});
