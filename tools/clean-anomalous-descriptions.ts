// tools/clean-anomalous-descriptions.ts
import { prisma } from "../server/db";
import { cleanDescription, isAnomalousDescription } from "../server/utils/textCleaner";
import { backfillShow } from "../server/metadataBackfill";

async function main() {
  console.log("🔍 Escaneando base de datos en busca de sinopsis y portadas con anomalías...");
  const shows = await prisma.show.findMany({
    select: { id: true, title: true, description: true, poster_url: true, banner_url: true },
  });

  console.log(`Analizando ${shows.length} obras en el catálogo...`);
  let fixedDescCount = 0;
  let veranimesRepaired = 0;

  for (const show of shows) {
    let needsUpdate = false;
    const updateData: Record<string, string> = {};

    // 1. Limpieza de descripciones
    if (show.description && isAnomalousDescription(show.description, show.title)) {
      const cleaned = cleanDescription(show.description, show.title);
      if (cleaned && cleaned !== show.description) {
        updateData.description = cleaned;
        needsUpdate = true;
        fixedDescCount++;
      }
    }

    // 2. Si el banner es idéntico al poster vertical (patrón común de VerAnimes), limpiar banner_url
    if (show.banner_url && show.poster_url && show.banner_url === show.poster_url) {
      // Dejar que el background backfill lo rellene con un backdrop 16:9 de TMDB
      updateData.banner_url = "";
      needsUpdate = true;
    }

    if (needsUpdate) {
      await prisma.show.update({
        where: { id: show.id },
        data: updateData,
      });
    }

    // 3. Si proviene de VerAnimes o tiene imagen de baja calidad, ejecutar backfill para recuperar póster HD de AniList/TMDB
    const isVerAnimes =
      (show.poster_url && show.poster_url.includes("veranimes.net")) ||
      (show.banner_url && show.banner_url.includes("veranimes.net"));

    if (isVerAnimes && veranimesRepaired < 100) {
      try {
        const res = await backfillShow(show.id);
        if (res.changed.length > 0) {
          veranimesRepaired++;
          console.log(`✨ [VerAnimes #${veranimesRepaired}] Enriquecido en HD: "${show.title}" -> ${res.changed.join(", ")}`);
        }
      } catch {}
    }
  }

  console.log(`🎉 Proceso completado:`);
  console.log(`   - ${fixedDescCount} descripciones reparadas.`);
  console.log(`   - ${veranimesRepaired} obras de VerAnimes enriquecidas con portadas HD.`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
