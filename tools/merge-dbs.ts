#!/usr/bin/env node
// tools/merge-dbs.ts
// ══════════════════════════════════════════════════════════════════
// FUSIÓN DE BASES DE DATOS: merge N archivos SQLite en 1 master.
//
// Uso:
//   npx tsx tools/merge-dbs.ts master.db source1.db source2.db ...
//   npx tsx tools/merge-dbs.ts master.db ./instances/*/prisma/dev.db
//
// Características:
//   - Idempotente: puede correrse múltiples veces sin duplicar
//   - Dedup por: mal_id, normalized_title+kind+year, tmdb_id
//   - Fusiona episodios, sourceLinks, mediaItems, mediaEpisodes
//   - Muestra estadísticas al finalizar
// ══════════════════════════════════════════════════════════════════

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

interface MergeStats {
  shows: { total: number; imported: number; skipped: number; updated: number };
  episodes: { total: number; imported: number; skipped: number };
  sourceLinks: { total: number; imported: number; skipped: number };
  mediaItems: { total: number; imported: number; skipped: number };
  mediaEpisodes: { total: number; imported: number; skipped: number };
}

function createStats(): MergeStats {
  return {
    shows: { total: 0, imported: 0, skipped: 0, updated: 0 },
    episodes: { total: 0, imported: 0, skipped: 0 },
    sourceLinks: { total: 0, imported: 0, skipped: 0 },
    mediaItems: { total: 0, imported: 0, skipped: 0 },
    mediaEpisodes: { total: 0, imported: 0, skipped: 0 },
  };
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function mergeDatabases(masterPath: string, sourcePaths: string[]): MergeStats {
  const stats = createStats();

  console.log(`\n🔀 Fusionando ${sourcePaths.length} base(s) de datos en: ${masterPath}\n`);

  // Abrir master
  const master = new Database(masterPath);
  master.pragma("journal_mode = WAL");
  master.pragma("busy_timeout = 30000");

  // Preparar statements de inserción
  const insertShow = master.prepare(`
    INSERT OR IGNORE INTO Show (id, mal_id, anilist_id, tmdb_id, title, original_title, japanese_title, english_title,
      normalized_title, base_normalized_title, description, poster_url, banner_url, poster_path, backdrop_path,
      category, rating, year, status, genres, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertEpisode = master.prepare(`
    INSERT OR IGNORE INTO Episode (id, show_id, episode_number, title, source_url)
    VALUES (?, ?, ?, ?, ?)
  `);

  const insertSourceLink = master.prepare(`
    INSERT OR IGNORE INTO SourceLink (id, media_episode_id, source_site, url, link_type, host, priority_tier, is_verified, last_checked)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMediaItem = master.prepare(`
    INSERT OR IGNORE INTO MediaItem (id, normalized_title, base_normalized_title, title, original_title, tmdb_id, kind, year, poster_url, poster_path, backdrop_path, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMediaEpisode = master.prepare(`
    INSERT OR IGNORE INTO MediaEpisode (id, media_item_id, season_number, episode_number, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  // Verificar si show ya existe
  const findShowByMalId = master.prepare(`SELECT id FROM Show WHERE mal_id = ?`);
  const findShowByNorm = master.prepare(`SELECT id FROM Show WHERE normalized_title = ? AND category = ?`);
  const findShowByTmdb = master.prepare(`SELECT id FROM Show WHERE tmdb_id = ?`);
  const findEpisodeByShowAndNumber = master.prepare(`SELECT id FROM Episode WHERE show_id = ? AND episode_number = ?`);

  for (const sourcePath of sourcePaths) {
    if (!fs.existsSync(sourcePath)) {
      console.log(`⚠️  No existe: ${sourcePath}`);
      continue;
    }

    console.log(`📂 Procesando: ${path.basename(sourcePath)}`);
    const source = new Database(sourcePath, { readonly: true });

    // ── Shows ──
    const shows = source.prepare("SELECT * FROM Show").all() as any[];
    stats.shows.total += shows.length;

    const mergeShows = master.transaction(() => {
      for (const show of shows) {
        // Dedup por mal_id
        if (show.mal_id) {
          const existing = findShowByMalId.get(show.mal_id);
          if (existing) { stats.shows.skipped++; continue; }
        }
        // Dedup por normalized_title + category
        const norm = normalizeTitle(show.title);
        if (norm) {
          const existing = findShowByNorm.get(norm, show.category || "anime");
          if (existing) { stats.shows.skipped++; continue; }
        }
        // Dedup por tmdb_id
        if (show.tmdb_id) {
          const existing = findShowByTmdb.get(show.tmdb_id);
          if (existing) { stats.shows.skipped++; continue; }
        }

        try {
          insertShow.run(
            show.id, show.mal_id, show.anilist_id, show.tmdb_id,
            show.title, show.original_title, show.japanese_title, show.english_title,
            norm, show.base_normalized_title, show.description,
            show.poster_url, show.banner_url, show.poster_path, show.backdrop_path,
            show.category, show.rating, show.year, show.status, show.genres,
            show.created_at, show.updated_at
          );
          stats.shows.imported++;
        } catch (e: any) {
          if (e?.code === "SQLITE_CONSTRAINT_UNIQUE" || e?.code === "SQLITE_CONSTRAINT") {
            stats.shows.skipped++;
          } else {
            console.log(`  ⚠️  Error importando show "${show.title}": ${e.message}`);
          }
        }
      }
    });
    mergeShows();

    // ── Episodes ──
    const episodes = source.prepare("SELECT * FROM Episode").all() as any[];
    stats.episodes.total += episodes.length;

    const mergeEpisodes = master.transaction(() => {
      for (const ep of episodes) {
        const existing = findEpisodeByShowAndNumber.get(ep.show_id, ep.episode_number);
        if (existing) { stats.episodes.skipped++; continue; }
        try {
          insertEpisode.run(ep.id, ep.show_id, ep.episode_number, ep.title, ep.source_url);
          stats.episodes.imported++;
        } catch { stats.episodes.skipped++; }
      }
    });
    mergeEpisodes();

    // ── SourceLinks ──
    try {
      const sourceLinks = source.prepare("SELECT * FROM SourceLink").all() as any[];
      stats.sourceLinks.total += sourceLinks.length;

      const findLinkByUrl = master.prepare(`SELECT id FROM SourceLink WHERE url = ?`);

      const mergeLinks = master.transaction(() => {
        for (const link of sourceLinks) {
          const existing = findLinkByUrl.get(link.url);
          if (existing) { stats.sourceLinks.skipped++; continue; }
          try {
            insertSourceLink.run(
              link.id, link.media_episode_id, link.source_site, link.url,
              link.link_type, link.host, link.priority_tier, link.is_verified, link.last_checked
            );
            stats.sourceLinks.imported++;
          } catch { stats.sourceLinks.skipped++; }
        }
      });
      mergeLinks();
    } catch { /* tabla no existe en source */ }

    // ── MediaItems ──
    try {
      const items = source.prepare("SELECT * FROM MediaItem").all() as any[];
      stats.mediaItems.total += items.length;

      const findItemByNorm = master.prepare(`SELECT id FROM MediaItem WHERE normalized_title = ? AND kind = ?`);

      const mergeItems = master.transaction(() => {
        for (const item of items) {
          const existing = findItemByNorm.get(item.normalized_title, item.kind || "movie");
          if (existing) { stats.mediaItems.skipped++; continue; }
          try {
            insertMediaItem.run(
              item.id, item.normalized_title, item.base_normalized_title, item.title,
              item.original_title, item.tmdb_id, item.kind, item.year,
              item.poster_url, item.poster_path, item.backdrop_path, item.created_at
            );
            stats.mediaItems.imported++;
          } catch { stats.mediaItems.skipped++; }
        }
      });
      mergeItems();
    } catch { /* tabla no existe en source */ }

    // ── MediaEpisodes ──
    try {
      const eps = source.prepare("SELECT * FROM MediaEpisode").all() as any[];
      stats.mediaEpisodes.total += eps.length;

      const findMediaEp = master.prepare(`SELECT id FROM MediaEpisode WHERE media_item_id = ? AND season_number = ? AND episode_number = ?`);

      const mergeMediaEps = master.transaction(() => {
        for (const ep of eps) {
          const existing = findMediaEp.get(ep.media_item_id, ep.season_number, ep.episode_number);
          if (existing) { stats.mediaEpisodes.skipped++; continue; }
          try {
            insertMediaEpisode.run(ep.id, ep.media_item_id, ep.season_number, ep.episode_number, ep.created_at);
            stats.mediaEpisodes.imported++;
          } catch { stats.mediaEpisodes.skipped++; }
        }
      });
      mergeMediaEps();
    } catch { /* tabla no existe en source */ }

    source.close();
  }

  master.close();
  return stats;
}

// ── Main ──

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (args.length < 2) {
  console.log(`
🔧 Fusor de Bases de Datos - VoidStream

Uso:
  npx tsx tools/merge-dbs.ts master.db source1.db [source2.db ...]
  npx tsx tools/merge-dbs.ts master.db ./instances/*/prisma/dev.db

Ejemplo:
  npx tsx tools/merge-dbs.ts prisma/dev.db instance1/prisma/dev.db instance2/prisma/dev.db
  `);
  process.exit(0);
}

const masterPath = args[0];
const sourcePaths = args.slice(1);

// Crear master si no existe
if (!fs.existsSync(masterPath)) {
  console.log(`📁 Creando master: ${masterPath}`);
  // Copiar esquema del primer source
  if (sourcePaths.length > 0 && fs.existsSync(sourcePaths[0])) {
    fs.copyFileSync(sourcePaths[0], masterPath);
    // Limpiar datos (mantener esquema)
    const tmp = new Database(masterPath);
    tmp.pragma("journal_mode = WAL");
    for (const table of ["Show", "Episode", "SourceLink", "MediaItem", "MediaEpisode", "CrawlTask", "SiteRating", "WorkerSettingsStore"]) {
      try { tmp.exec(`DELETE FROM ${table}`); } catch {}
    }
    tmp.close();
  }
}

const stats = mergeDatabases(masterPath, sourcePaths);

// Imprimir estadísticas
console.log(`\n${"═".repeat(50)}`);
console.log(`📊 ESTADÍSTICAS DE FUSIÓN`);
console.log(`${"═".repeat(50)}`);
console.log(`Shows:       ${stats.shows.imported} importados / ${stats.shows.skipped} duplicados / ${stats.shows.total} total`);
console.log(`Episodes:    ${stats.episodes.imported} importados / ${stats.episodes.skipped} duplicados / ${stats.episodes.total} total`);
console.log(`SourceLinks: ${stats.sourceLinks.imported} importados / ${stats.sourceLinks.skipped} duplicados / ${stats.sourceLinks.total} total`);
console.log(`MediaItems:  ${stats.mediaItems.imported} importados / ${stats.mediaItems.skipped} duplicados / ${stats.mediaItems.total} total`);
console.log(`MediaEps:    ${stats.mediaEpisodes.imported} importados / ${stats.mediaEpisodes.skipped} duplicados / ${stats.mediaEpisodes.total} total`);
console.log(`${"═".repeat(50)}`);
console.log(`✅ Fusión completada: ${masterPath}`);
