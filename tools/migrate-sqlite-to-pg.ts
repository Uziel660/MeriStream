#!/usr/bin/env node
// tools/migrate-sqlite-to-pg.ts
// ══════════════════════════════════════════════════════════════════
// MIGRACIÓN SQLite → PostgreSQL
//
// Lee TODOS los datos del SQLite actual y los inserta en PostgreSQL.
// Idempotente: puede correrse múltiples veces sin duplicar.
//
// Uso:
//   1. Setear DATABASE_URL en .env (PostgreSQL)
//   2. Copiar schema-postgresql.prisma → schema.prisma
//   3. npx prisma db push
//   4. npx tsx tools/migrate-sqlite-to-pg.ts
//
// Requiere: better-sqlite3 (npm install better-sqlite3 @types/better-sqlite3)
// ══════════════════════════════════════════════════════════════════

import Database from "better-sqlite3";
import { PrismaClient } from "@prisma/client";
import path from "path";
import fs from "fs";

const SQLITE_PATH = path.join(process.cwd(), "prisma", "dev.db");
const pg = new PrismaClient();

interface Stats {
  shows: { total: number; imported: number; skipped: number };
  episodes: { total: number; imported: number; skipped: number };
  sourceLinks: { total: number; imported: number; skipped: number };
  mediaItems: { total: number; imported: number; skipped: number };
  mediaEpisodes: { total: number; imported: number; skipped: number };
  siteRatings: { total: number; imported: number; skipped: number };
  crawlTasks: { total: number; imported: number; skipped: number };
}

function createStats(): Stats {
  return {
    shows: { total: 0, imported: 0, skipped: 0 },
    episodes: { total: 0, imported: 0, skipped: 0 },
    sourceLinks: { total: 0, imported: 0, skipped: 0 },
    mediaItems: { total: 0, imported: 0, skipped: 0 },
    mediaEpisodes: { total: 0, imported: 0, skipped: 0 },
    siteRatings: { total: 0, imported: 0, skipped: 0 },
    crawlTasks: { total: 0, imported: 0, skipped: 0 },
  };
}

async function migrate() {
  if (!fs.existsSync(SQLITE_PATH)) {
    console.log(`❌ No se encontró SQLite: ${SQLITE_PATH}`);
    process.exit(1);
  }

  console.log(`\n🔀 Migrando SQLite → PostgreSQL\n`);
  console.log(`   SQLite: ${SQLITE_PATH}`);
  console.log(`   PostgreSQL: ${process.env.DATABASE_URL ? "✅ configurado" : "❌ no configurado"}\n`);

  if (!process.env.DATABASE_URL) {
    console.log(`   Agrega DATABASE_URL a tu .env:`);
    console.log(`   DATABASE_URL="postgresql://user:password@localhost:5432/voidstream?schema=public"`);
    process.exit(1);
  }

  const sqlite = new Database(SQLITE_PATH, { readonly: true });
  const stats = createStats();

  // ── Shows ──
  console.log(`📺 Migrando Shows...`);
  const shows = sqlite.prepare("SELECT * FROM Show").all() as any[];
  stats.shows.total = shows.length;

  for (const show of shows) {
    try {
      // Dedup por mal_id o normalized_title
      const existing = await pg.show.findFirst({
        where: {
          OR: [
            show.mal_id ? { mal_id: show.mal_id } : undefined,
            { normalized_title: show.normalized_title, category: show.category || "anime" },
          ].filter(Boolean) as any,
        },
        select: { id: true },
      });

      if (existing) {
        stats.shows.skipped++;
        // Actualizar IDs en episodios si es necesario
        continue;
      }

      await pg.show.create({
        data: {
          id: show.id,
          mal_id: show.mal_id,
          anilist_id: show.anilist_id,
          tmdb_id: show.tmdb_id,
          title: show.title,
          original_title: show.original_title,
          japanese_title: show.japanese_title,
          english_title: show.english_title,
          normalized_title: show.normalized_title,
          base_normalized_title: show.base_normalized_title,
          description: show.description || "",
          poster_url: show.poster_url,
          banner_url: show.banner_url,
          poster_path: show.poster_path,
          backdrop_path: show.backdrop_path,
          category: show.category || "anime",
          rating: show.rating || 8.0,
          year: show.year || 2024,
          status: show.status || "Finalizado",
          genres: show.genres || "Multimedia",
          created_at: new Date(show.created_at),
          updated_at: new Date(show.updated_at),
        },
      });
      stats.shows.imported++;
    } catch (e: any) {
      if (e?.code === "P2002") {
        stats.shows.skipped++;
      } else {
        console.log(`  ⚠️  Error show "${show.title}": ${e.message?.slice(0, 80)}`);
        stats.shows.skipped++;
      }
    }
  }
  console.log(`   ✅ ${stats.shows.imported} importados / ${stats.shows.skipped} duplicados`);

  // ── Episodes ──
  console.log(`🎬 Migrando Episodes...`);
  const episodes = sqlite.prepare("SELECT * FROM Episode").all() as any[];
  stats.episodes.total = episodes.length;

  for (const ep of episodes) {
    try {
      // Verificar que el show existe en PG
      const showExists = await pg.show.findUnique({ where: { id: ep.show_id }, select: { id: true } });
      if (!showExists) { stats.episodes.skipped++; continue; }

      // Verificar duplicado
      const existing = await pg.episode.findFirst({
        where: { show_id: ep.show_id, episode_number: ep.episode_number },
        select: { id: true },
      });
      if (existing) { stats.episodes.skipped++; continue; }

      await pg.episode.create({
        data: {
          id: ep.id,
          show_id: ep.show_id,
          title: ep.title,
          episode_number: ep.episode_number,
          source_url: ep.source_url || "",
          created_at: new Date(ep.created_at),
          updated_at: new Date(ep.updated_at),
        },
      });
      stats.episodes.imported++;
    } catch (e: any) {
      if (e?.code === "P2002") stats.episodes.skipped++;
      else stats.episodes.skipped++;
    }
  }
  console.log(`   ✅ ${stats.episodes.imported} importados / ${stats.episodes.skipped} duplicados`);

  // ── MediaItems ──
  console.log(`📦 Migrando MediaItems...`);
  try {
    const items = sqlite.prepare("SELECT * FROM MediaItem").all() as any[];
    stats.mediaItems.total = items.length;

    for (const item of items) {
      try {
        const existing = await pg.mediaItem.findFirst({
          where: { normalized_title: item.normalized_title, kind: item.kind || "movie" },
          select: { id: true },
        });
        if (existing) { stats.mediaItems.skipped++; continue; }

        await pg.mediaItem.create({
          data: {
            id: item.id,
            normalized_title: item.normalized_title,
            base_normalized_title: item.base_normalized_title,
            title: item.title,
            original_title: item.original_title,
            tmdb_id: item.tmdb_id,
            kind: item.kind || "movie",
            year: item.year,
            poster_url: item.poster_url,
            poster_path: item.poster_path,
            backdrop_path: item.backdrop_path,
            created_at: new Date(item.created_at),
            updated_at: new Date(item.updated_at),
          },
        });
        stats.mediaItems.imported++;
      } catch { stats.mediaItems.skipped++; }
    }
    console.log(`   ✅ ${stats.mediaItems.imported} importados / ${stats.mediaItems.skipped} duplicados`);
  } catch { console.log(`   ⏭️  Tabla MediaItem no encontrada en SQLite`); }

  // ── MediaEpisodes ──
  console.log(`📺 Migrando MediaEpisodes...`);
  try {
    const eps = sqlite.prepare("SELECT * FROM MediaEpisode").all() as any[];
    stats.mediaEpisodes.total = eps.length;

    for (const ep of eps) {
      try {
        const itemExists = await pg.mediaItem.findUnique({ where: { id: ep.media_item_id }, select: { id: true } });
        if (!itemExists) { stats.mediaEpisodes.skipped++; continue; }

        const existing = await pg.mediaEpisode.findFirst({
          where: { media_item_id: ep.media_item_id, season_number: ep.season_number, episode_number: ep.episode_number },
          select: { id: true },
        });
        if (existing) { stats.mediaEpisodes.skipped++; continue; }

        await pg.mediaEpisode.create({
          data: {
            id: ep.id,
            media_item_id: ep.media_item_id,
            season_number: ep.season_number,
            episode_number: ep.episode_number,
            created_at: new Date(ep.created_at),
            updated_at: new Date(ep.updated_at),
          },
        });
        stats.mediaEpisodes.imported++;
      } catch { stats.mediaEpisodes.skipped++; }
    }
    console.log(`   ✅ ${stats.mediaEpisodes.imported} importados / ${stats.mediaEpisodes.skipped} duplicados`);
  } catch { console.log(`   ⏭️  Tabla MediaEpisode no encontrada en SQLite`); }

  // ── SourceLinks ──
  console.log(`🔗 Migrando SourceLinks...`);
  try {
    const links = sqlite.prepare("SELECT * FROM SourceLink").all() as any[];
    stats.sourceLinks.total = links.length;

    for (const link of links) {
      try {
        const epExists = await pg.mediaEpisode.findUnique({ where: { id: link.media_episode_id }, select: { id: true } });
        if (!epExists) { stats.sourceLinks.skipped++; continue; }

        const existing = await pg.sourceLink.findFirst({
          where: { media_episode_id: link.media_episode_id, source_site: link.source_site, url: link.url },
          select: { id: true },
        });
        if (existing) { stats.sourceLinks.skipped++; continue; }

        await pg.sourceLink.create({
          data: {
            id: link.id,
            media_episode_id: link.media_episode_id,
            source_site: link.source_site,
            url: link.url,
            link_type: link.link_type || "direct",
            host: link.host,
            priority_tier: link.priority_tier,
            is_verified: link.is_verified || false,
            last_checked: link.last_checked ? new Date(link.last_checked) : null,
          },
        });
        stats.sourceLinks.imported++;
      } catch { stats.sourceLinks.skipped++; }
    }
    console.log(`   ✅ ${stats.sourceLinks.imported} importados / ${stats.sourceLinks.skipped} duplicados`);
  } catch { console.log(`   ⏭️  Tabla SourceLink no encontrada en SQLite`); }

  // ── SiteRatings ──
  console.log(`⭐ Migrando SiteRatings...`);
  try {
    const ratings = sqlite.prepare("SELECT * FROM SiteRating").all() as any[];
    stats.siteRatings.total = ratings.length;

    for (const r of ratings) {
      try {
        const existing = await pg.siteRating.findUnique({ where: { site: r.site }, select: { id: true } });
        if (existing) { stats.siteRatings.skipped++; continue; }

        await pg.siteRating.create({
          data: { id: r.id, site: r.site, rating: r.rating, enabled: r.enabled, notes: r.notes },
        });
        stats.siteRatings.imported++;
      } catch { stats.siteRatings.skipped++; }
    }
    console.log(`   ✅ ${stats.siteRatings.imported} importados / ${stats.siteRatings.skipped} duplicados`);
  } catch { console.log(`   ⏭️  Tabla SiteRating no encontrada en SQLite`); }

  // ── CrawlTasks (opcional: historial de jobs) ──
  console.log(`📋 Migrando CrawlTasks (historial)...`);
  try {
    const tasks = sqlite.prepare("SELECT * FROM CrawlTask").all() as any[];
    stats.crawlTasks.total = tasks.length;

    for (const t of tasks) {
      try {
        const existing = await pg.crawlTask.findUnique({ where: { id: t.id }, select: { id: true } });
        if (existing) { stats.crawlTasks.skipped++; continue; }

        await pg.crawlTask.create({
          data: {
            id: t.id,
            name: t.name,
            target_url: t.target_url,
            status: t.status,
            scope: t.scope || "catalog_pages",
            max_pages: t.max_pages || 1,
            current_page: t.current_page || 0,
            total_discovered: t.total_discovered || 0,
            shows_imported: t.shows_imported || 0,
            episodes_imported: t.episodes_imported || 0,
            rate_limit_delay_ms: t.rate_limit_delay_ms || 1500,
            items_queue: t.items_queue || "[]",
            current_item_title: t.current_item_title,
            error_message: t.error_message,
            logs: t.logs || "[]",
            created_at: new Date(t.created_at),
            updated_at: new Date(t.updated_at),
          },
        });
        stats.crawlTasks.imported++;
      } catch { stats.crawlTasks.skipped++; }
    }
    console.log(`   ✅ ${stats.crawlTasks.imported} importados / ${stats.crawlTasks.skipped} duplicados`);
  } catch { console.log(`   ⏭️  Tabla CrawlTask no encontrada en SQLite`); }

  // ── WorkerSettings ──
  console.log(`⚙️  Migrando WorkerSettings...`);
  try {
    const settings = sqlite.prepare("SELECT * FROM WorkerSettingsStore").all() as any[];
    for (const s of settings) {
      await pg.workerSettingsStore.upsert({
        where: { id: s.id },
        update: {
          default_delay_ms: s.default_delay_ms,
          jitter_enabled: s.jitter_enabled,
          max_concurrent_jobs: s.max_concurrent_jobs,
          user_agent_rotation: s.user_agent_rotation,
        },
        create: {
          id: s.id,
          default_delay_ms: s.default_delay_ms,
          jitter_enabled: s.jitter_enabled,
          max_concurrent_jobs: s.max_concurrent_jobs,
          user_agent_rotation: s.user_agent_rotation,
        },
      });
    }
    console.log(`   ✅ Settings migrados`);
  } catch { console.log(`   ⏭️  Tabla WorkerSettingsStore no encontrada`); }

  sqlite.close();
  await pg.$disconnect();

  // ── Resumen ──
  console.log(`\n${"═".repeat(60)}`);
  console.log(`📊 RESUMEN DE MIGRACIÓN SQLite → PostgreSQL`);
  console.log(`${"═".repeat(60)}`);
  console.log(`Shows:       ${stats.shows.imported} importados / ${stats.shows.skipped} skips / ${stats.shows.total} total`);
  console.log(`Episodes:    ${stats.episodes.imported} importados / ${stats.episodes.skipped} skips / ${stats.episodes.total} total`);
  console.log(`MediaItems:  ${stats.mediaItems.imported} importados / ${stats.mediaItems.skipped} skips / ${stats.mediaItems.total} total`);
  console.log(`MediaEps:    ${stats.mediaEpisodes.imported} importados / ${stats.mediaEpisodes.skipped} skips / ${stats.mediaEpisodes.total} total`);
  console.log(`SourceLinks: ${stats.sourceLinks.imported} importados / ${stats.sourceLinks.skipped} skips / ${stats.sourceLinks.total} total`);
  console.log(`SiteRatings: ${stats.siteRatings.imported} importados / ${stats.siteRatings.skipped} skips / ${stats.siteRatings.total} total`);
  console.log(`CrawlTasks:  ${stats.crawlTasks.imported} importados / ${stats.crawlTasks.skipped} skips / ${stats.crawlTasks.total} total`);
  console.log(`${"═".repeat(60)}`);
  console.log(`✅ Migración completada.`);
  console.log(`\nAhora actualiza schema.prisma para usar PostgreSQL:`);
  console.log(`   cp prisma/schema-postgresql.prisma prisma/schema.prisma`);
  console.log(`   npx prisma db push`);
  console.log(`   npm run dev`);
}

migrate().catch(console.error);
