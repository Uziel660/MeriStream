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
  { target_url: "https://www3.animeflv.net/browse", name: "AnimeFLV (Catálogo Completo)", scope: "full_catalog" as const },
  { target_url: "https://lamovie.org/peliculas", name: "LaMovie Películas (Catálogo Completo)", scope: "full_catalog" as const },
  { target_url: "https://lamovie.org/series", name: "LaMovie Series (Catálogo Completo)", scope: "full_catalog" as const },
  { target_url: "https://lamovie.org/anime", name: "LaMovie Anime (Catálogo Completo)", scope: "full_catalog" as const },
  { target_url: "https://cinecalidad.am", name: "Cinecalidad (Catálogo Completo)", scope: "full_catalog" as const },
  { target_url: "https://tubepelis.com/peliculas", name: "TubePelis Películas (Catálogo Completo)", scope: "full_catalog" as const },
  { target_url: "https://tubepelis.com/series", name: "TubePelis Series (Catálogo Completo)", scope: "full_catalog" as const },
  { target_url: "https://tioplus.app/peliculas", name: "TioPlus Películas (Catálogo Completo)", scope: "full_catalog" as const },
  { target_url: "https://tioplus.app/series", name: "TioPlus Series (Catálogo Completo)", scope: "full_catalog" as const },
  { target_url: "https://latanime.org/browse", name: "LatAnime (Catálogo Completo)", scope: "full_catalog" as const },
  { target_url: "https://tioanime.com/browse", name: "TioAnime (Catálogo Completo)", scope: "full_catalog" as const },
  { target_url: "https://wwv.veranimes.net", name: "VerAnimes (Catálogo Completo)", scope: "full_catalog" as const },
];

async function main() {
  const dry = process.argv.includes("--dry");

  // 1. Actualizar settings a máxima potencia
  console.log("⚙️  Configurando worker a máxima potencia...");
  await prisma.workerSettingsStore.upsert({
    where: { id: "default" },
    update: {
      default_delay_ms: 800,
      jitter_enabled: true,
      max_concurrent_jobs: 5,
      user_agent_rotation: true,
    },
    create: {
      id: "default",
      default_delay_ms: 800,
      jitter_enabled: true,
      max_concurrent_jobs: 5,
      user_agent_rotation: true,
    },
  });

  // 2. Verificar jobs existentes
  const existing = await prisma.crawlTask.findMany({
    where: { status: { in: ["pending", "running"] } },
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
        rate_limit_delay_ms: 800,
        items_queue: "[]",
        error_message: null,
        logs: JSON.stringify([{
          timestamp: new Date().toISOString(),
          level: "info",
          message: `Tarea de BARRIDO COMPLETO creada automáticamente. Delay: 800ms.`,
        }]),
      },
    });
    console.log(`✅ Colado: ${job.name}`);
    created++;
  }

  console.log(`\n📊 Resumen:`);
  console.log(`   Jobs creados: ${created}`);
  console.log(`   Jobs ya existentes: ${existing.length}`);
  console.log(`   Config: max_jobs=5, delay=800ms`);
  console.log(`\n🚀 El worker arrancará automáticamente al iniciar el server.`);
  console.log(`   Ejecuta: npm run dev`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
