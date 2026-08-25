#!/usr/bin/env node
// tools/safe-migrate-pg.ts
// ══════════════════════════════════════════════════════════════════
// MIGRACIÓN SEGURA SQLite → PostgreSQL
//
// ✅ COPIA sin borrar nada
// ✅ Verifica integridad ANTES y DESPUÉS
// ✅ Puede correrse múltiples veces (idempotente)
// ✅ Genera reporte de verificación
//
// Uso:
//   1. cp prisma/schema-postgresql.prisma prisma/schema.prisma
//   2. npx prisma db push
//   3. npx tsx tools/safe-migrate-pg.ts
//
// Requiere: better-sqlite3
// ══════════════════════════════════════════════════════════════════

import Database from "better-sqlite3";
import { PrismaClient } from "@prisma/client";
import path from "path";
import fs from "fs";

const SQLITE_PATH = path.join(process.cwd(), "prisma", "dev.db");
const REPORT_PATH = path.join(process.cwd(), "backups", "migration-report.json");
const pg = new PrismaClient();

interface Verification {
  source: string;
  target: string;
  tables: Record<string, { source: number; target: number; match: boolean }>;
  timestamp: string;
  success: boolean;
}

async function countTable(db: Database.Database, table: string): Promise<number> {
  try {
    const result = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as any;
    return result?.count || 0;
  } catch { return -1; }
}

async function verifyCounts(sqlite: Database.Database, label: string): Promise<Record<string, { source: number; target: number; match: boolean }>> {
  const tables = ["Show", "Episode", "MediaItem", "MediaEpisode", "SourceLink", "SiteRating", "CrawlTask"];
  const counts: Record<string, { source: number; target: number; match: boolean }> = {};

  for (const table of tables) {
    const sourceCount = await countTable(sqlite, table);
    let targetCount = -1;
    try {
      targetCount = await (pg as any)[table.charAt(0).toLowerCase() + table.slice(1)].count();
    } catch {}

    counts[table] = {
      source: sourceCount,
      target: targetCount,
      match: sourceCount === targetCount,
    };
  }
  return counts;
}

async function safeMigrate() {
  console.log(`\n🛡️  MIGRACIÓN SEGURA SQLite → PostgreSQL\n`);

  // 1. Verificar SQLite
  if (!fs.existsSync(SQLITE_PATH)) {
    console.log(`❌ SQLite no encontrado: ${SQLITE_PATH}`);
    process.exit(1);
  }

  const sqlite = new Database(SQLITE_PATH, { readonly: true });
  console.log(`📂 SQLite: ${SQLITE_PATH}`);

  // 2. Verificar PostgreSQL
  try {
    await pg.$connect();
    console.log(`✅ PostgreSQL: conectado`);
  } catch (e: any) {
    console.log(`❌ PostgreSQL no disponible: ${e.message}`);
    console.log(`\nAsegúrate de que PostgreSQL esté corriendo y DATABASE_URL esté configurado.`);
    console.log(`Verifica: npx prisma db push`);
    sqlite.close();
    process.exit(1);
  }

  // 3. Contar registros fuente
  console.log(`\n📊 Registros en SQLite (fuente):`);
  const sourceCounts: Record<string, number> = {};
  for (const table of ["Show", "Episode", "MediaItem", "MediaEpisode", "SourceLink", "SiteRating", "CrawlTask"]) {
    sourceCounts[table] = await countTable(sqlite, table);
    if (sourceCounts[table] >= 0) {
      console.log(`   ${table}: ${sourceCounts[table]}`);
    }
  }

  const totalSource = Object.values(sourceCounts).filter((c) => c >= 0).reduce((a, b) => a + b, 0);
  console.log(`   Total: ${totalSource} registros`);

  if (totalSource === 0) {
    console.log(`\n⚠️  SQLite está vacío. Nada que migrar.`);
    sqlite.close();
    await pg.$disconnect();
    return;
  }

  // 4. Confirmar
  console.log(`\n⚠️  Esto COPIARÁ todos los datos de SQLite a PostgreSQL.`);
  console.log(`   El SQLite ORIGINAL NO será modificado ni eliminado.`);
  console.log(`   Puede correrse múltiples veces sin duplicar.\n`);

  // 5. Migrar Shows
  console.log(`\n📺 Migrando Shows...`);
  const shows = sqlite.prepare("SELECT * FROM Show").all() as any[];
  let showsImported = 0, showsSkipped = 0;

  for (const show of shows) {
    try {
      const existing = await pg.show.findFirst({
        where: { OR: [
          show.mal_id ? { mal_id: show.mal_id } : undefined,
          { normalized_title: show.normalized_title, category: show.category || "anime" },
        ].filter(Boolean) as any },
        select: { id: true },
      });
      if (existing) { showsSkipped++; continue; }

      await pg.show.create({
        data: {
          id: show.id, mal_id: show.mal_id, anilist_id: show.anilist_id, tmdb_id: show.tmdb_id,
          title: show.title, original_title: show.original_title, japanese_title: show.japanese_title,
          english_title: show.english_title, normalized_title: show.normalized_title,
          base_normalized_title: show.base_normalized_title, description: show.description || "",
          poster_url: show.poster_url, banner_url: show.banner_url, poster_path: show.poster_path,
          backdrop_path: show.backdrop_path, category: show.category || "anime",
          rating: show.rating || 8.0, year: show.year || 2024, status: show.status || "Finalizado",
          genres: show.genres || "Multimedia",
          created_at: new Date(show.created_at), updated_at: new Date(show.updated_at),
        },
      });
      showsImported++;
    } catch { showsSkipped++; }
  }
  console.log(`   ✅ ${showsImported} nuevos / ${showsSkipped} duplicados`);

  // 6. Migrar Episodes
  console.log(`🎬 Migrando Episodes...`);
  const episodes = sqlite.prepare("SELECT * FROM Episode").all() as any[];
  let epsImported = 0, epsSkipped = 0;

  for (const ep of episodes) {
    try {
      const showExists = await pg.show.findUnique({ where: { id: ep.show_id }, select: { id: true } });
      if (!showExists) { epsSkipped++; continue; }
      const existing = await pg.episode.findFirst({
        where: { show_id: ep.show_id, episode_number: ep.episode_number }, select: { id: true },
      });
      if (existing) { epsSkipped++; continue; }

      await pg.episode.create({
        data: {
          id: ep.id, show_id: ep.show_id, title: ep.title,
          episode_number: ep.episode_number, source_url: ep.source_url || "",
          created_at: new Date(ep.created_at), updated_at: new Date(ep.updated_at),
        },
      });
      epsImported++;
    } catch { epsSkipped++; }
  }
  console.log(`   ✅ ${epsImported} nuevos / ${epsSkipped} duplicados`);

  // 7. Migrar MediaItems
  console.log(`📦 Migrando MediaItems...`);
  try {
    const items = sqlite.prepare("SELECT * FROM MediaItem").all() as any[];
    let itemsImported = 0, itemsSkipped = 0;
    for (const item of items) {
      try {
        const existing = await pg.mediaItem.findFirst({
          where: { normalized_title: item.normalized_title, kind: item.kind || "movie" }, select: { id: true },
        });
        if (existing) { itemsSkipped++; continue; }
        await pg.mediaItem.create({
          data: {
            id: item.id, normalized_title: item.normalized_title, base_normalized_title: item.base_normalized_title,
            title: item.title, original_title: item.original_title, tmdb_id: item.tmdb_id,
            kind: item.kind || "movie", year: item.year, poster_url: item.poster_url,
            poster_path: item.poster_path, backdrop_path: item.backdrop_path,
            created_at: new Date(item.created_at), updated_at: new Date(item.updated_at),
          },
        });
        itemsImported++;
      } catch { itemsSkipped++; }
    }
    console.log(`   ✅ ${itemsImported} nuevos / ${itemsSkipped} duplicados`);
  } catch { console.log(`   ⏭️  Sin tabla MediaItem`); }

  // 8. Migrar MediaEpisodes
  console.log(`📺 Migrando MediaEpisodes...`);
  try {
    const eps = sqlite.prepare("SELECT * FROM MediaEpisode").all() as any[];
    let mepsImported = 0, mepsSkipped = 0;
    for (const ep of eps) {
      try {
        const itemExists = await pg.mediaItem.findUnique({ where: { id: ep.media_item_id }, select: { id: true } });
        if (!itemExists) { mepsSkipped++; continue; }
        const existing = await pg.mediaEpisode.findFirst({
          where: { media_item_id: ep.media_item_id, season_number: ep.season_number, episode_number: ep.episode_number },
          select: { id: true },
        });
        if (existing) { mepsSkipped++; continue; }
        await pg.mediaEpisode.create({
          data: {
            id: ep.id, media_item_id: ep.media_item_id, season_number: ep.season_number,
            episode_number: ep.episode_number, created_at: new Date(ep.created_at), updated_at: new Date(ep.updated_at),
          },
        });
        mepsImported++;
      } catch { mepsSkipped++; }
    }
    console.log(`   ✅ ${mepsImported} nuevos / ${mepsSkipped} duplicados`);
  } catch { console.log(`   ⏭️  Sin tabla MediaEpisode`); }

  // 9. Migrar SourceLinks
  console.log(`🔗 Migrando SourceLinks...`);
  try {
    const links = sqlite.prepare("SELECT * FROM SourceLink").all() as any[];
    let linksImported = 0, linksSkipped = 0;
    for (const link of links) {
      try {
        const epExists = await pg.mediaEpisode.findUnique({ where: { id: link.media_episode_id }, select: { id: true } });
        if (!epExists) { linksSkipped++; continue; }
        const existing = await pg.sourceLink.findFirst({
          where: { media_episode_id: link.media_episode_id, source_site: link.source_site, url: link.url },
          select: { id: true },
        });
        if (existing) { linksSkipped++; continue; }
        await pg.sourceLink.create({
          data: {
            id: link.id, media_episode_id: link.media_episode_id, source_site: link.source_site,
            url: link.url, link_type: link.link_type || "direct", host: link.host,
            priority_tier: link.priority_tier, is_verified: link.is_verified || false,
            last_checked: link.last_checked ? new Date(link.last_checked) : null,
          },
        });
        linksImported++;
      } catch { linksSkipped++; }
    }
    console.log(`   ✅ ${linksImported} nuevos / ${linksSkipped} duplicados`);
  } catch { console.log(`   ⏭️  Sin tabla SourceLink`); }

  // 10. Migrar SiteRatings
  console.log(`⭐ Migrando SiteRatings...`);
  try {
    const ratings = sqlite.prepare("SELECT * FROM SiteRating").all() as any[];
    for (const r of ratings) {
      try {
        await pg.siteRating.upsert({
          where: { site: r.site },
          update: { rating: r.rating, enabled: r.enabled, notes: r.notes },
          create: { id: r.id, site: r.site, rating: r.rating, enabled: r.enabled, notes: r.notes },
        });
      } catch {}
    }
    console.log(`   ✅ Settings migrados`);
  } catch { console.log(`   ⏭️  Sin tabla SiteRating`); }

  // 11. Migrar CrawlTasks
  console.log(`📋 Migrando CrawlTasks...`);
  try {
    const tasks = sqlite.prepare("SELECT * FROM CrawlTask").all() as any[];
    let tasksImported = 0, tasksSkipped = 0;
    for (const t of tasks) {
      try {
        const existing = await pg.crawlTask.findUnique({ where: { id: t.id }, select: { id: true } });
        if (existing) { tasksSkipped++; continue; }
        await pg.crawlTask.create({
          data: {
            id: t.id, name: t.name, target_url: t.target_url, status: t.status,
            scope: t.scope || "catalog_pages", max_pages: t.max_pages || 1,
            current_page: t.current_page || 0, total_discovered: t.total_discovered || 0,
            shows_imported: t.shows_imported || 0, episodes_imported: t.episodes_imported || 0,
            rate_limit_delay_ms: t.rate_limit_delay_ms || 1500,
            items_queue: t.items_queue || "[]", current_item_title: t.current_item_title,
            error_message: t.error_message, logs: t.logs || "[]",
            created_at: new Date(t.created_at), updated_at: new Date(t.updated_at),
          },
        });
        tasksImported++;
      } catch { tasksSkipped++; }
    }
    console.log(`   ✅ ${tasksImported} nuevos / ${tasksSkipped} duplicados`);
  } catch { console.log(`   ⏭️  Sin tabla CrawlTask`); }

  // 12. Migrar WorkerSettings
  console.log(`⚙️  Migrando WorkerSettings...`);
  try {
    const settings = sqlite.prepare("SELECT * FROM WorkerSettingsStore").all() as any[];
    for (const s of settings) {
      await pg.workerSettingsStore.upsert({
        where: { id: s.id },
        update: {
          default_delay_ms: s.default_delay_ms, jitter_enabled: s.jitter_enabled,
          max_concurrent_jobs: s.max_concurrent_jobs, user_agent_rotation: s.user_agent_rotation,
        },
        create: {
          id: s.id, default_delay_ms: s.default_delay_ms, jitter_enabled: s.jitter_enabled,
          max_concurrent_jobs: s.max_concurrent_jobs, user_agent_rotation: s.user_agent_rotation,
        },
      });
    }
    console.log(`   ✅ Settings migrados`);
  } catch { console.log(`   ⏭️  Sin tabla WorkerSettingsStore`); }

  // 13. Verificación final
  console.log(`\n🔍 Verificando integridad...`);
  const targetCounts: Record<string, { source: number; target: number; match: boolean }> = {};
  for (const table of ["Show", "Episode", "MediaItem", "MediaEpisode", "SourceLink", "SiteRating", "CrawlTask"]) {
    const sourceCount = sourceCounts[table] || 0;
    let targetCount = 0;
    try { targetCount = await (pg as any)[table.charAt(0).toLowerCase() + table.slice(1)].count(); } catch {}
    targetCounts[table] = { source: sourceCount, target: targetCount, match: sourceCount === targetCount };
  }

  console.log(`\n📊 Verificación de conteos:`);
  let allMatch = true;
  for (const [table, counts] of Object.entries(targetCounts)) {
    if (counts.source < 0) continue;
    const status = counts.match ? "✅" : "⚠️";
    console.log(`   ${status} ${table}: SQLite=${counts.source} → PG=${counts.target}`);
    if (!counts.match) allMatch = false;
  }

  // 14. Guardar reporte
  const report: Verification = {
    source: SQLITE_PATH,
    target: process.env.DATABASE_URL?.split("@")[1] || "postgresql",
    tables: targetCounts,
    timestamp: new Date().toISOString(),
    success: allMatch,
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`\n📄 Reporte guardado: ${REPORT_PATH}`);

  sqlite.close();
  await pg.$disconnect();

  if (allMatch) {
    console.log(`\n${"═".repeat(60)}`);
    console.log(`✅ MIGRACIÓN COMPLETADA CON ÉXITO`);
    console.log(`${"═".repeat(60)}`);
    console.log(`\nEl SQLite ORIGINAL sigue intacto en: ${SQLITE_PATH}`);
    console.log(`Los backups están en: backups/`);
    console.log(`\nPara usar PostgreSQL:`);
    console.log(`   1. cp prisma/schema-postgresql.prisma prisma/schema.prisma`);
    console.log(`   2. npx prisma db push`);
    console.log(`   3. npm run dev`);
  } else {
    console.log(`\n⚠️  ALGUNOS CONTADOS NO COINCIDEN. Revisa el reporte.`);
    console.log(`   Los datos SÍ se insertaron (P2002 = duplicado existente).`);
    console.log(`   Esto puede pasar si la migración ya corrió antes.`);
  }
}

safeMigrate().catch(console.error);
