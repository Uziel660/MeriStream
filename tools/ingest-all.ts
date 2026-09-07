#!/usr/bin/env node
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { getEnabledIngestionTargets } from "../server/providers/ingestionRegistry";

const prisma = new PrismaClient();

const args = new Set(process.argv.slice(2));
const dry = args.has("--dry");
const refresh = args.has("--refresh");
const fast = args.has("--fast");

const settings = fast
  ? { delay: 0, maxJobs: 6 }
  : { delay: 750, maxJobs: 4 };

async function main() {
  const targets = getEnabledIngestionTargets();
  if (targets.length === 0) throw new Error("No hay providers con targets de ingestión habilitados");

  console.log(`\n[MeriStream] ingest:all`);
  console.log(`Providers/targets: ${targets.length}`);
  console.log(`Modo: ${fast ? "FAST" : "SAFE"}${refresh ? " + REFRESH" : ""}${dry ? " + DRY" : ""}`);

  if (!dry) {
    await prisma.workerSettingsStore.upsert({
      where: { id: "default" },
      update: {
        default_delay_ms: settings.delay,
        jitter_enabled: true,
        max_concurrent_jobs: settings.maxJobs,
        user_agent_rotation: true,
      },
      create: {
        id: "default",
        default_delay_ms: settings.delay,
        jitter_enabled: true,
        max_concurrent_jobs: settings.maxJobs,
        user_agent_rotation: true,
      },
    });
  }

  const existing = await prisma.crawlTask.findMany({
    where: { target_url: { in: targets.map((t) => t.targetUrl) } },
    select: { id: true, target_url: true, status: true },
  });
  const byUrl = new Map(existing.map((job) => [job.target_url, job]));

  let created = 0;
  let requeued = 0;
  let skipped = 0;

  for (const target of targets) {
    const found = byUrl.get(target.targetUrl);

    if (found) {
      if (!refresh) {
        console.log(`SKIP  ${target.name} (${found.status})`);
        skipped++;
        continue;
      }

      if (found.status === "running") {
        console.log(`LIVE  ${target.name} (ya corriendo)`);
        skipped++;
        continue;
      }

      if (dry) {
        console.log(`DRY   reencolaría ${target.name}`);
        requeued++;
        continue;
      }

      await prisma.crawlTask.update({
        where: { id: found.id },
        data: {
          name: target.name,
          status: "pending",
          scope: "full_catalog",
          max_pages: 0,
          current_page: 0,
          total_discovered: 0,
          shows_imported: 0,
          episodes_imported: 0,
          rate_limit_delay_ms: settings.delay,
          items_queue: "[]",
          current_item_title: null,
          error_message: null,
          logs: JSON.stringify([{ timestamp: new Date().toISOString(), level: "info", message: "Reencolado por npm run ingest:all -- --refresh" }]),
        },
      });
      console.log(`RESET ${target.name}`);
      requeued++;
      continue;
    }

    if (dry) {
      console.log(`DRY   crearía ${target.name}`);
      created++;
      continue;
    }

    const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await prisma.crawlTask.create({
      data: {
        id,
        name: target.name,
        target_url: target.targetUrl,
        status: "pending",
        scope: "full_catalog",
        max_pages: 0,
        current_page: 0,
        total_discovered: 0,
        shows_imported: 0,
        episodes_imported: 0,
        rate_limit_delay_ms: settings.delay,
        items_queue: "[]",
        error_message: null,
        logs: JSON.stringify([{ timestamp: new Date().toISOString(), level: "info", message: "Barrido completo creado por npm run ingest:all" }]),
      },
    });
    console.log(`ADD   ${target.name}`);
    created++;
  }

  console.log(`\nResumen: created=${created}, requeued=${requeued}, skipped=${skipped}`);
  console.log(`Worker: max_jobs=${settings.maxJobs}, delay=${settings.delay}ms`);
  if (!dry) {
    console.log("\nAhora inicia el servidor con: npm run dev");
    console.log("El worker recogerá automáticamente todas las tareas full_catalog pendientes.");
  }
}

main()
  .catch((error) => {
    console.error("[ingest:all]", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
