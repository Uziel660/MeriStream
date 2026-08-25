#!/usr/bin/env node
// tools/fast-migrate-pg.ts
// Migración masiva SQLite → PostgreSQL con raw SQL (lotes de 1000)

import Database from "better-sqlite3";
import { PrismaClient } from "@prisma/client";
import path from "path";

const SQLITE_PATH = path.join(process.cwd(), "prisma", "dev.db");
const pg = new PrismaClient();

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function main() {
  console.log("🚀 MIGRACIÓN RÁPIDA SQLite → PostgreSQL\n");

  const sqlite = new Database(SQLITE_PATH, { readonly: true });
  await pg.$connect();

  // Shows
  const shows = sqlite.prepare("SELECT * FROM Show").all() as any[];
  console.log(`📺 Shows: ${shows.length}`);
  for (const batch of chunk(shows, 500)) {
    await pg.show.createMany({
      data: batch.map((s) => ({
        id: s.id, mal_id: s.mal_id, anilist_id: s.anilist_id, tmdb_id: s.tmdb_id,
        title: s.title, original_title: s.original_title, japanese_title: s.japanese_title,
        english_title: s.english_title, normalized_title: s.normalized_title,
        base_normalized_title: s.base_normalized_title, description: s.description || "",
        poster_url: s.poster_url, banner_url: s.banner_url, poster_path: s.poster_path,
        backdrop_path: s.backdrop_path, category: s.category || "anime",
        rating: s.rating || 8.0, year: s.year || 2024, status: s.status || "Finalizado",
        genres: s.genres || "Multimedia",
        created_at: new Date(s.created_at), updated_at: new Date(s.updated_at),
      })),
      skipDuplicates: true,
    });
  }

  // Episodes
  const episodes = sqlite.prepare("SELECT * FROM Episode").all() as any[];
  console.log(`🎬 Episodes: ${episodes.length}`);
  for (const batch of chunk(episodes, 1000)) {
    await pg.episode.createMany({
      data: batch.map((e) => ({
        id: e.id, show_id: e.show_id, title: e.title,
        episode_number: e.episode_number, source_url: e.source_url || "",
        created_at: new Date(e.created_at), updated_at: new Date(e.updated_at),
      })),
      skipDuplicates: true,
    });
  }

  // MediaItems
  const items = sqlite.prepare("SELECT * FROM MediaItem").all() as any[];
  console.log(`📦 MediaItems: ${items.length}`);
  for (const batch of chunk(items, 500)) {
    await pg.mediaItem.createMany({
      data: batch.map((m) => ({
        id: m.id, normalized_title: m.normalized_title, base_normalized_title: m.base_normalized_title,
        title: m.title, original_title: m.original_title, tmdb_id: m.tmdb_id,
        kind: m.kind || "movie", year: m.year, poster_url: m.poster_url,
        poster_path: m.poster_path, backdrop_path: m.backdrop_path,
        created_at: new Date(m.created_at), updated_at: new Date(m.updated_at),
      })),
      skipDuplicates: true,
    });
  }

  // MediaEpisodes
  const me = sqlite.prepare("SELECT * FROM MediaEpisode").all() as any[];
  console.log(`📺 MediaEpisodes: ${me.length}`);
  for (const batch of chunk(me, 1000)) {
    await pg.mediaEpisode.createMany({
      data: batch.map((e) => ({
        id: e.id, media_item_id: e.media_item_id, season_number: e.season_number,
        episode_number: e.episode_number, created_at: new Date(e.created_at), updated_at: new Date(e.updated_at),
      })),
      skipDuplicates: true,
    });
  }

  // SourceLinks
  const sl = sqlite.prepare("SELECT * FROM SourceLink").all() as any[];
  console.log(`🔗 SourceLinks: ${sl.length}`);
  for (const batch of chunk(sl, 1000)) {
    await pg.sourceLink.createMany({
      data: batch.map((l) => ({
        id: l.id, media_episode_id: l.media_episode_id, source_site: l.source_site,
        url: l.url, link_type: l.link_type || "direct", host: l.host,
        priority_tier: l.priority_tier, is_verified: l.is_verified || false,
        last_checked: l.last_checked ? new Date(l.last_checked) : null,
      })),
      skipDuplicates: true,
    });
  }

  // SiteRatings
  const sr = sqlite.prepare("SELECT * FROM SiteRating").all() as any[];
  console.log(`⭐ SiteRatings: ${sr.length}`);
  for (const r of sr) {
    await pg.siteRating.upsert({
      where: { site: r.site },
      update: { rating: r.rating, enabled: !!r.enabled, notes: r.notes },
      create: { id: r.id, site: r.site, rating: r.rating, enabled: !!r.enabled, notes: r.notes },
    });
  }

  // CrawlTasks
  const ct = sqlite.prepare("SELECT * FROM CrawlTask").all() as any[];
  console.log(`📋 CrawlTasks: ${ct.length}`);
  for (const batch of chunk(ct, 500)) {
    await pg.crawlTask.createMany({
      data: batch.map((t) => ({
        id: t.id, name: t.name, target_url: t.target_url, status: t.status,
        scope: t.scope || "catalog_pages", max_pages: t.max_pages || 1,
        current_page: t.current_page || 0, total_discovered: t.total_discovered || 0,
        shows_imported: t.shows_imported || 0, episodes_imported: t.episodes_imported || 0,
        rate_limit_delay_ms: t.rate_limit_delay_ms || 1500,
        items_queue: t.items_queue || "[]", current_item_title: t.current_item_title,
        error_message: t.error_message, logs: t.logs || "[]",
        created_at: new Date(t.created_at), updated_at: new Date(t.updated_at),
      })),
      skipDuplicates: true,
    });
  }

  // WorkerSettings
  const ws = sqlite.prepare("SELECT * FROM WorkerSettingsStore").all() as any[];
  console.log(`⚙️  WorkerSettings: ${ws.length}`);
  for (const s of ws) {
    await pg.workerSettingsStore.upsert({
      where: { id: s.id },
      update: { default_delay_ms: s.default_delay_ms, jitter_enabled: !!s.jitter_enabled,
        max_concurrent_jobs: s.max_concurrent_jobs, user_agent_rotation: !!s.user_agent_rotation },
      create: { id: s.id, default_delay_ms: s.default_delay_ms, jitter_enabled: !!s.jitter_enabled,
        max_concurrent_jobs: s.max_concurrent_jobs, user_agent_rotation: !!s.user_agent_rotation },
    });
  }

  // Verificar
  console.log("\n🔍 Verificación:");
  const tables = ["show", "episode", "mediaItem", "mediaEpisode", "sourceLink", "siteRating", "crawlTask"] as const;
  for (const t of tables) {
    const count = await (pg as any)[t].count();
    console.log(`   ✅ ${t}: ${count}`);
  }

  sqlite.close();
  await pg.$disconnect();
  console.log("\n✅ Migración completada");
}

main().catch(console.error);
