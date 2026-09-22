import { prisma } from "../server/db";
import { reconcileSequelsByTmdb, mergeTwoShows } from "../server/reconcileCatalog";
import { backfillShow, showNeedsBackfill } from "../server/metadataBackfill";
import { cleanDescription, isAnomalousDescription } from "../server/utils/textCleaner";

async function main() {
  console.log("=== INICIANDO LIMPIEZA EXHAUSTIVA DE METADATOS Y FUSIÓN DE DUPLICADOS ===");

  // 1. Fusionar duplicados TMDB (Secuelas y matches idénticos)
  console.log("\n[1] Fusionando duplicados por TMDB ID (Show)...");
  const reconcileResult = await reconcileSequelsByTmdb({ dryRun: false });
  console.log(`- Grupos revisados: ${reconcileResult.groups_checked}`);
  console.log(`- Fusiones realizadas: ${reconcileResult.merges_done}`);

  // 2. Limpieza exhaustiva de descripciones (Show y MediaItem)
  console.log("\n[2] Barrido de descripciones anómalas (Show)...");
  
  let totalShowsCleaned = 0;
  let totalShowsBackfilled = 0;
  let skip = 0;
  const take = 500;
  
  while (true) {
    const shows = await prisma.show.findMany({
      skip,
      take,
      select: { id: true, title: true, description: true, poster_url: true, genres: true, year: true }
    });
    
    if (shows.length === 0) break;
    
    for (const show of shows) {
      let updated = false;
      if (isAnomalousDescription(show.description, show.title)) {
        const cleaned = cleanDescription(show.description, show.title);
        if (cleaned !== show.description && cleaned.length > 5) {
          await prisma.show.update({
            where: { id: show.id },
            data: { description: cleaned }
          });
          updated = true;
          totalShowsCleaned++;
        }
      }
      
      if (updated || showNeedsBackfill(show)) {
        try {
          const res = await backfillShow(show.id);
          if (res.changed.length > 0) totalShowsBackfilled++;
        } catch (e) {
          // Ignorar fallos de backfill
        }
      }
    }
    
    skip += take;
    process.stdout.write(`  ... Procesados ${skip} Shows\r`);
  }
  console.log(`\n- Shows con descripciones limpiadas: ${totalShowsCleaned}`);
  console.log(`- Shows rellenados desde TMDB/AniList: ${totalShowsBackfilled}`);

  // Limpieza en MediaItem
  console.log("\n[3] Barrido de descripciones anómalas (MediaItem)...");
  skip = 0;
  let totalMediaItemsCleaned = 0;
  while (true) {
    const items = await prisma.mediaItem.findMany({
      skip,
      take,
      select: { id: true, title: true, overview: true }
    });
    
    if (items.length === 0) break;
    
    for (const item of items) {
      if (isAnomalousDescription(item.overview, item.title)) {
        const cleaned = cleanDescription(item.overview, item.title);
        if (cleaned !== item.overview && cleaned.length > 5) {
          await prisma.mediaItem.update({
            where: { id: item.id },
            data: { overview: cleaned }
          });
          totalMediaItemsCleaned++;
        }
      }
    }
    
    skip += take;
    process.stdout.write(`  ... Procesados ${skip} MediaItems\r`);
  }
  console.log(`\n- MediaItems con descripciones limpiadas: ${totalMediaItemsCleaned}`);

  // 3. Eliminar títulos basura
  console.log("\n[4] Eliminando títulos basura y placeholders...");
  const TITLE_BLACKLIST = ["sin titulo", "sin título", "unknown", "test", "prueba", "ejemplo", "placeholder", "temp", "tmp", "n/a", "null", "undefined"];
  
  let deletedShows = 0;
  for (const bad of TITLE_BLACKLIST) {
    const res = await prisma.show.deleteMany({
      where: { title: { equals: bad, mode: "insensitive" } }
    });
    deletedShows += res.count;
  }
  console.log(`- Shows basura eliminados: ${deletedShows}`);

  // 4. Buscar y fusionar duplicados por título normalizado
  console.log("\n[5] Buscando y fusionando duplicados por base_normalized_title...");
  const allNormalized = await prisma.show.findMany({
    where: { base_normalized_title: { not: null, notIn: [""] } },
    select: { id: true, base_normalized_title: true, title: true, created_at: true },
    orderBy: { created_at: "asc" }
  });

  const titleCounts = new Map<string, any[]>();
  for (const s of allNormalized) {
    const key = s.base_normalized_title!;
    if (!titleCounts.has(key)) titleCounts.set(key, []);
    titleCounts.get(key)!.push(s);
  }

  let mergedNormalizedCount = 0;
  for (const [title, shows] of titleCounts) {
    if (shows.length > 1) {
      const keep = shows[0]; // Conservar el más antiguo
      for (let i = 1; i < shows.length; i++) {
        const merge = shows[i];
        try {
          const res = await mergeTwoShows(keep.id, merge.id, { dryRun: false });
          if (res.ok) {
            mergedNormalizedCount++;
          }
        } catch (e: any) {
          // Ignore
        }
      }
    }
  }
  console.log(`- Duplicados por nombre fusionados: ${mergedNormalizedCount}`);

  console.log("\n=== LIMPIEZA EXHAUSTIVA COMPLETADA ===");
}

main().catch(e => {
  console.error(e);
  process.exit(1);
}).finally(() => {
  prisma.$disconnect();
});
