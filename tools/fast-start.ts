#!/usr/bin/env node
// tools/fast-start.ts
// ══════════════════════════════════════════════════════════════════
// ARRANQUE RÁPIDO: configura el worker a máxima potencia y cola
// automáticamente todos los jobs de sitios reales.
//
// Uso:
//   npx tsx tools/fast-start.ts           (arranca server + workers)
//   npx tsx tools/fast-start.ts --dry     (solo muestra qué haría)
// ══════════════════════════════════════════════════════════════════

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Todos los sitios reales (excluidos archive, direct, test)
const JOBS = [
  { target_url: "https://ww3.gnulahd.nu/", name: "GNULA (Catálogo Completo)", scope: "full_catalog" as const },
  // www3.animeflv.net responde 521. El directorio vivo de este proveedor usa
  // /anime/ y pagina con /anime/page/<n>/.
  { target_url: "https://animeflv.or.at/anime/", name: "AnimeFLV (Catálogo Completo)", scope: "full_catalog" as const },
  // JKanime expone 4.896 fichas en 164 páginas; es la fuente amplia vigente
  // para el ecosistema AnimeFLV, no un sustituto ficticio del historial.
  { target_url: "https://jkanime.net/directorio/", name: "JKanime (Catálogo Completo)", scope: "full_catalog" as const },
  { target_url: "https://hianimes.se/filter?type=All&page=1", name: "HiAnimes (Catálogo Completo)", scope: "full_catalog" as const },
  { target_url: "https://lamovie.org/peliculas", name: "LaMovie Películas (Catálogo Completo)", scope: "full_catalog" as const },
  { target_url: "https://lamovie.org/wp-api/v1/listing/movies?page=1&postType=tvshows&postsPerPage=24", name: "LaMovie Series (Catálogo Completo)", scope: "full_catalog" as const },
  { target_url: "https://lamovie.org/wp-api/v1/listing/movies?page=1&postType=animes&postsPerPage=24", name: "LaMovie Anime (Catálogo Completo)", scope: "full_catalog" as const },
  { target_url: "https://cinecalidad.am", name: "Cinecalidad (Catálogo Completo)", scope: "full_catalog" as const },
  { target_url: "https://tioplus.app/peliculas", name: "TioPlus Películas (Catálogo Completo)", scope: "full_catalog" as const },
  { target_url: "https://tioplus.app/series", name: "TioPlus Series (Catálogo Completo)", scope: "full_catalog" as const },
  { target_url: "https://doramasflix.io/doramas", name: "Doramasflix Doramas (Catálogo Completo)", scope: "full_catalog" as const },
  { target_url: "https://doramasflix.io/peliculas", name: "Doramasflix Películas (Catálogo Completo)", scope: "full_catalog" as const },
  { target_url: "https://doramasflix.io/variedades", name: "Doramasflix Variedades (Catálogo Completo)", scope: "full_catalog" as const },
  // El directorio visible de LatAnime pagina con ?p=N; /browse no es catálogo.
  { target_url: "https://latanime.org/animes?p=1", name: "LatAnime (Catálogo Completo)", scope: "full_catalog" as const },
  // /browse es 404 en TioAnime; /directorio es el catálogo paginado real.
  { target_url: "https://tioanime.com/directorio", name: "TioAnime (Catálogo Completo)", scope: "full_catalog" as const },
  { target_url: "https://wwv.veranimes.net", name: "VerAnimes (Catálogo Completo)", scope: "full_catalog" as const },
];

async function main() {
  const dry = process.argv.includes("--dry");

  // 1. Actualizar settings a máxima potencia
  console.log("⚙️  Configurando worker a máxima potencia...");
  await prisma.workerSettingsStore.upsert({
    where: { id: "default" },
    update: {
      default_delay_ms: 0,
      jitter_enabled: true,
      // Seis procesos han sido el máximo estable observado en esta máquina.
      // Más concurrencia llevó Node al límite de memoria durante imports reales.
      max_concurrent_jobs: 6,
      user_agent_rotation: true,
    },
    create: {
      id: "default",
      default_delay_ms: 0,
      jitter_enabled: true,
      max_concurrent_jobs: 6,
      user_agent_rotation: true,
    },
  });

  // 2. Verificar jobs existentes
  const existing = await prisma.crawlTask.findMany({
    select: { target_url: true, status: true },
  });
  const existingUrls = new Set(existing.map((j) => j.target_url));

  // 3. Colar jobs que no estén ya en cola
  let created = 0;
  for (const job of JOBS) {
    if (existingUrls.has(job.target_url)) {
      console.log(`⏭️  Ya existe: ${job.name}`);
      continue;
    }
    if (dry) {
      console.log(`[DRY] Crearía: ${job.name}`);
      created++;
      continue;
    }

    const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await prisma.crawlTask.create({
      data: {
        id,
        name: job.name,
        target_url: job.target_url,
        status: "pending",
        scope: job.scope,
        max_pages: 0,
        current_page: 0,
        total_discovered: 0,
        shows_imported: 0,
        episodes_imported: 0,
        rate_limit_delay_ms: 0,
        items_queue: "[]",
        error_message: null,
        logs: JSON.stringify([{
          timestamp: new Date().toISOString(),
          level: "info",
          message: `Tarea de BARRIDO COMPLETO creada automáticamente. Delay: 0ms.`,
        }]),
      },
    });
    console.log(`✅ Colado: ${job.name}`);
    created++;
  }

  console.log(`\n📊 Resumen:`);
  console.log(`   Jobs creados: ${created}`);
  console.log(`   Jobs ya existentes: ${existing.length}`);
  console.log(`   Config: max_jobs=6, delay=0ms`);
  console.log(`\n🚀 El worker arrancará automáticamente al iniciar el server.`);
  console.log(`   Ejecuta: npm run dev`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
