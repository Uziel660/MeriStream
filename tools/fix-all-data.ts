import { PrismaClient } from "@prisma/client";
import { cleanDescription, isAnomalousDescription } from "../server/utils/textCleaner";

const p = new PrismaClient();

const SCRAPING_ARTIFACTS: RegExp[] = [
  /ver\s+pel[ií]cula[s]?\s*(online)?(\s*gratis)?/gi,
  /ver\s+online\s*(gratis)?/gi,
  /cinecalidad(\.\w+)?/gi,
  /veranimes(\.\w+)?(\.net)?/gi,
  /tubepelis(\.\w+)?/gi,
  /latanime(\.\w+)?/gi,
  /animeflv(\.\w+)?/gi,
  /tioanime(\.\w+)?/gi,
  /lamovie(\.\w+)?/gi,
  /descargar\s+(gratis|por\s+mega|torrent)/gi,
  /(hd\s*720p?|1080p|4k|latino\s*hd|espa[ñn]ol\s+latino|sub\s*espa[ñn]ol|castellano|calidad\s*(hd|ts|cam))/gi,
];

const PLACEHOLDER_PATTERNS = [
  /^contenido indexado/i,
  /^obra multimedia indexada/i,
  /^a[uú]n no hemos a[ñn]adido/i,
  /^sinopsis no disponible/i,
  /^no description available/i,
  /^descripci[oó]n no disponible/i,
  /^importado de/i,
];

function containsCJK(text: string): boolean {
  return /[぀-ヿ㐀-䶿一-鿿가-힯]/.test(text);
}

function cleanArtifacts(text: string): string {
  let t = text;
  for (const re of SCRAPING_ARTIFACTS) t = t.replace(re, " ");
  return t.replace(/\s+/g, " ").replace(/^[.,;:\s\-–—]+/, "").trim();
}

(async () => {
  await p.$connect();
  console.log("=== REPARACIÓN CONSOLIDADA ===\n");

  // ── 1. Descripciones (terminar pendientes) ──
  const shows = await p.show.findMany({
    select: { id: true, title: true, description: true },
  });
  const updates: Array<{ id: string; description: string }> = [];
  for (const s of shows) {
    const raw = (s.description || "").trim();
    if (raw === "" || PLACEHOLDER_PATTERNS.some((re) => re.test(raw))) continue;
    if (containsCJK(raw)) { updates.push({ id: s.id, description: "" }); continue; }
    let cleaned = raw;
    if (isAnomalousDescription(cleaned, s.title)) cleaned = cleanDescription(cleaned, s.title);
    cleaned = cleanArtifacts(cleaned);
    if (cleaned !== raw) {
      if (cleaned.length < 40) {
        const stillArtifact = /veranimes|cinecalidad|tubepelis|pel[ií]cula/i.test(raw);
        updates.push({ id: s.id, description: stillArtifact ? "" : raw });
      } else {
        updates.push({ id: s.id, description: cleaned });
      }
    }
  }
  console.log(`Descripciones a limpiar: ${updates.length}`);
  for (let i = 0; i < updates.length; i += 250) {
    const chunk = updates.slice(i, i + 250);
    await p.$transaction(chunk.map((u) => p.show.update({ where: { id: u.id }, data: { description: u.description } })));
  }
  console.log(`  ✓ ${updates.length} descripciones procesadas`);

  // ── 2. Banner duplicado = poster ──
  const dupBanner = await p.$executeRawUnsafe(
    `UPDATE "Show" SET banner_url = NULL WHERE banner_url IS NOT NULL AND poster_url IS NOT NULL AND banner_url = poster_url`
  );
  console.log(`  ✓ ${dupBanner} banner=poster limpiados`);

  // ── 3. Posters y banners VerAnimes / Unsplash ──
  const verPoster = await p.$executeRawUnsafe(
    `UPDATE "Show" SET poster_url = NULL WHERE poster_url ILIKE '%veranimes%' OR poster_url ILIKE '%unsplash%'`
  );
  const verBanner = await p.$executeRawUnsafe(
    `UPDATE "Show" SET banner_url = NULL WHERE banner_url ILIKE '%veranimes%' OR banner_url ILIKE '%unsplash%'`
  );
  console.log(`  ✓ ${verPoster} posters baja calidad limpiados`);
  console.log(`  ✓ ${verBanner} banners baja calidad limpiados`);

  // ── 4. Fusionar grupos tmdb_id duplicados ──
  const groups = await p.$queryRawUnsafe<Array<{ tmdb_id: number; ids: string[] }>>(
    `SELECT tmdb_id, ARRAY_AGG(id) AS ids FROM "Show" WHERE tmdb_id IS NOT NULL GROUP BY tmdb_id HAVING COUNT(*) > 1`
  );
  let mergedGroups = 0, deletedShows = 0, movedEps = 0;
  for (const g of groups) {
    const ids = g.ids || [];
    if (ids.length < 2) continue;
    // Primaria = más episodios
    const epCounts = await Promise.all(
      ids.map(async (id) => ({ id, c: await p.episode.count({ where: { show_id: id } }) }))
    );
    epCounts.sort((a, b) => b.c - a.c);
    const primary = epCounts[0].id;
    const secondaries = epCounts.slice(1).map((e) => e.id);
    const primaryShow = await p.show.findUnique({ where: { id: primary } });
    if (!primaryShow) continue;

    for (const sec of secondaries) {
      const secShow = await p.show.findUnique({ where: { id: sec } });
      if (!secShow) continue;
      const eps = await p.episode.findMany({ where: { show_id: sec } });
      for (const ep of eps) {
        const exists = await p.episode.findFirst({
          where: { show_id: primary, episode_number: ep.episode_number },
        });
        if (!exists) {
          await p.episode.update({ where: { id: ep.id }, data: { show_id: primary } });
          movedEps++;
        }
      }
      // Rellenar huecos de metadatos
      const fill: Record<string, string> = {};
      if ((!primaryShow.description || primaryShow.description.length < 40) && secShow.description && secShow.description.length >= 40) fill.description = secShow.description;
      if (!primaryShow.poster_url && secShow.poster_url) fill.poster_url = secShow.poster_url;
      if (!primaryShow.banner_url && secShow.banner_url) fill.banner_url = secShow.banner_url;
      if (!primaryShow.japanese_title && secShow.japanese_title) fill.japanese_title = secShow.japanese_title;
      if (!primaryShow.english_title && secShow.english_title) fill.english_title = secShow.english_title;
      if (Object.keys(fill).length > 0) {
        await p.show.update({ where: { id: primary }, data: fill as any });
      }
      await p.show.delete({ where: { id: sec } });
      deletedShows++;
      console.log(`  MERGE: "${secShow.title}" → "${primaryShow.title}" (tmdb=${g.tmdb_id}, ${eps.length} eps)`);
    }
    mergedGroups++;
  }
  console.log(`  ✓ ${mergedGroups} grupos fusionados, ${deletedShows} shows eliminados, ${movedEps} episodios movidos`);

  console.log("\n=== COMPLETADO ===");
  await p.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });