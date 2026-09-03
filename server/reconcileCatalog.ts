// server/reconcileCatalog.ts
// ══════════════════════════════════════════════════════════════════
// RECONCILIACIÓN DE SECUELAS YA EXISTENTES (S2/S3 guardadas como cartels
// separados). Agrupa obras por tmdb_id; cuando hay >1 con el mismo ID:
//   - La más antigua es la canónica.
//   - Cada secuela se MUEVE dentro de la canónica:
//       · Episodios legacy con numeración CONTINUA (una sola tarjeta).
//       · Fuentes multi-fuente → MediaItem canónico bajo la temporada que
//         corresponda (detectada del título; si no, la siguiente disponible).
//   - La fila de la secuela (y su MediaItem huérfano) se eliminan.
// Todo se ordena por las estadísticas de fuentes (SiteRating) al reproducir:
// el cascade ya rige el orden de plataformas.
// DRY RUN por defecto: primero reporta, no toca nada.
// ══════════════════════════════════════════════════════════════════

import { prisma } from "./db";
import { parseRawTitle, normalizeTitleKey } from "./utils/titleNormalizer";
import { parseTitleQuery } from "./metadataEngine";
import type { ContentKind } from "./types";

export interface ReconcileSummary {
  groups_checked: number;
  merges_done: number;
  episodes_moved: number;
  shows_deleted: number;
  dry_run: boolean;
  details: Array<{ canonical: string; merged: string; season: number; episodes_moved: number }>;
  skipped: Array<{ canonical: string; merged: string; reason: string }>;
}

export interface MediaItemReconcileSummary {
  groups_checked: number;
  merges_done: number;
  episodes_moved: number;
  media_items_deleted: number;
  dry_run: boolean;
  details: Array<{ canonical: string; merged: string; season: number; episodes_moved: number }>;
  skipped: Array<{ canonical: string; merged: string; reason: string }>;
}

/** Temporada de una secuela: marcador en el título > siguiente disponible. */
function detectSeason(title: string, kind?: string): number {
  const raw = parseRawTitle(title);
  if (raw.season && raw.season > 1) return raw.season;
  const parsed = parseTitleQuery(raw.canonical);
  if (parsed.season && parsed.season > 1) return parsed.season;
  // En anime/series algunos catálogos publican solo "Título 2". No aplicar
  // esta convención a películas, donde el número suele formar parte del
  // título de una secuela cinematográfica.
  if (kind !== "movie") {
    const bare = raw.canonical.match(/(?:^|\s)(\d{1,2})$/);
    const value = bare ? Number(bare[1]) : 0;
    if (value > 1 && value <= 20) return value;
  }
  return 0;
}

// ── SIMILITUD DE TÍTULOS (guarda anti-falsos-positivos) ──
// Los tmdb_ids vienen de matches automáticos: algunos son erróneos y agrupan
// obras DISTINTAS ("Todo o Nada" vs "Full Monty"). Sin guarda, la fusión
// corrompería el catálogo. Normaliza plurales/dobles letras para que
// "Haikyuu"/"Haikyu" cuenten como lo mismo.
function tokensOf(title: string): Set<string> {
  const norm = parseRawTitle(title)
    .canonical.toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/(.)\1+/g, "$1") // dobles letras: haikyuu → haikyu
    .replace(/[^a-z0-9 ]/g, " ");
  const raw = norm.split(/\s+/).filter((t) => t.length > 1);
  const out = new Set<string>();
  for (const t of raw) out.add(t.replace(/s$/, ""));
  return out;
}

function similarity(a: string, b: string): number {
  const A = tokensOf(a);
  const B = tokensOf(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter); // Jaccard
}

/** Decisión de auto-fusión segura entre dos títulos de un mismo tmdb_id. */
function shouldAutoMerge(
  titleA: string,
  titleB: string,
  kind: string,
  sequelTitle: string,
  aliasesA: string[] = [],
  aliasesB: string[] = [],
): { ok: boolean; reason: string; similarity: number } {
  // Las fuentes pueden guardar el mismo TMDB con títulos localizados. Usar
  // también los aliases persistidos evita dejar obras paralelas cuando, por
  // ejemplo, una trae el título español y otra el original/inglés.
  const pairs = [[titleA, titleB], ...aliasesA.flatMap((a) => aliasesB.map((b) => [a, b] as const))];
  const sim = Math.max(...pairs.map(([a, b]) => similarity(a, b)), 0);
  const hasMarker = detectSeason(sequelTitle, kind) > 1;
  // Películas: sin concepto de temporada, exigir similitud fuerte.
  // Con marcador explícito de temporada el umbral baja: el marcador + mismo
  // tmdb_id es evidencia fuerte (p.ej. "Haikyuu S3" vs "Haikyu S4").
  const minSim = kind === "movie" ? 0.5 : hasMarker ? 0.3 : 0.5;
  if (sim < minSim) {
    return { ok: false, reason: `similitud baja (${sim.toFixed(2)} < ${minSim})`, similarity: sim };
  }
  return { ok: true, reason: `similitud ${sim.toFixed(2)}${hasMarker ? " + marcador de temporada" : ""}`, similarity: sim };
}

/** TMDB comparte el espacio numérico entre tipos de TV, pero no con películas. */
function sameTmdbNamespace(left: string, right: string): boolean {
  const tvKinds = new Set(["anime", "series"]);
  const leftTv = tvKinds.has(left || "anime");
  const rightTv = tvKinds.has(right || "anime");
  return leftTv === rightTv && (leftTv || left === right);
}

/** Copia una fuente al episodio canónico sin perder evidencia ni receta JIT. */
async function copySourceLink(link: any, targetMediaEpisodeId: string): Promise<void> {
  await prisma.sourceLink
    .create({
      data: {
        media_episode_id: targetMediaEpisodeId,
        source_site: link.source_site,
        url: link.url,
        link_type: link.link_type,
        language: link.language,
        audio_language: link.audio_language,
        subtitle_language: link.subtitle_language,
        subtitles: link.subtitles ?? undefined,
        host: link.host,
        priority_tier: link.priority_tier,
        is_verified: link.is_verified,
        last_checked: link.last_checked,
        source_status: link.source_status,
        canonical_locator: link.canonical_locator,
        external_id: link.external_id,
        extraction_method: link.extraction_method,
        resolver_version: link.resolver_version,
        failure_reason: link.failure_reason,
        last_success: link.last_success,
        last_failure: link.last_failure,
        retry_after: link.retry_after,
      },
    })
    .catch((error: any) => {
      // Solo una colisión de la clave única significa que la fuente ya fue
      // copiada. Cualquier otro error (por ejemplo, una caída de PostgreSQL)
      // debe abortar la fusión para no borrar la única copia de la fuente.
      if (error?.code !== "P2002") throw error;
    });
}

export async function reconcileSequelsByTmdb(opts: { dryRun?: boolean } = {}): Promise<ReconcileSummary> {
  const dry = opts.dryRun !== false; // SEGURIDAD: dry run por defecto
  const summary: ReconcileSummary = {
    groups_checked: 0,
    merges_done: 0,
    episodes_moved: 0,
    shows_deleted: 0,
    dry_run: dry,
    details: [],
    skipped: [],
  };

  const dupGroups = await prisma.show.groupBy({
    by: ["tmdb_id"],
    where: { tmdb_id: { not: null } },
    _count: { _all: true },
    having: { tmdb_id: { _count: { gt: 1 } } },
  });
  summary.groups_checked = dupGroups.length;

  for (const g of dupGroups) {
    const shows = await prisma.show.findMany({
      where: { tmdb_id: g.tmdb_id! },
      orderBy: { created_at: "asc" },
    });
    if (shows.length < 2) continue;

    const canonical = shows[0];
    const kind = (canonical.category || "anime") as ContentKind;
    const cBase = canonical.base_normalized_title || canonical.normalized_title;

    // La identidad TMDB es la primera clave de unión. El título queda como
    // fallback para filas históricas que aún no heredaron el ID.
    let canonicalItem = await prisma.mediaItem.findFirst({
      where: { tmdb_id: g.tmdb_id!, kind },
      orderBy: { created_at: "asc" },
    });
    if (!canonicalItem) {
      // Algunos importadores clasificaron la misma obra como anime/series/tv.
      // TMDB sigue siendo una identidad más fuerte que esa etiqueta local.
      canonicalItem = await prisma.mediaItem.findFirst({
        where: { tmdb_id: g.tmdb_id! },
        orderBy: { created_at: "asc" },
      });
    }
    if (!canonicalItem) {
      canonicalItem = await prisma.mediaItem.findFirst({
        where: { OR: [{ base_normalized_title: cBase, kind }, { normalized_title: canonical.normalized_title, kind }] },
        orderBy: { created_at: "asc" },
      });
    }

    for (const sequel of shows.slice(1)) {
      // TMDB usa namespaces distintos para películas y TV: el mismo entero
      // puede existir en ambos tipos. Nunca fusionar entre categorías locales;
      // hacerlo convertiría una película y una serie en una sola obra aunque
      // compartan accidentalmente el número de TMDB.
      if (!sameTmdbNamespace(sequel.category || "anime", canonical.category || "anime")) {
        summary.skipped.push({
          canonical: canonical.title,
          merged: sequel.title,
          reason: `namespace distinto (${sequel.category || "anime"} ≠ ${canonical.category || "anime"})`,
        });
        continue;
      }
      // Una misma clave canónica puede representar duplicados reales que aún
      // viven en filas separadas; se fusionan bajo la misma temporada.
      const sBase = sequel.base_normalized_title || sequel.normalized_title;
      const sameBase = sBase === cBase;

      // GUARDA anti-falsos-positivos: títulos muy distintos con mismo tmdb_id
      // = match erróneo del importador. NO fusionar; reportar para revisión.
      const guard = shouldAutoMerge(
        canonical.title,
        sequel.title,
        kind,
        sequel.title,
        [canonical.original_title, canonical.english_title, canonical.japanese_title].filter(Boolean) as string[],
        [sequel.original_title, sequel.english_title, sequel.japanese_title].filter(Boolean) as string[],
      );
      if (!guard.ok) {
        summary.skipped.push({ canonical: canonical.title, merged: sequel.title, reason: guard.reason });
        console.log(`[Reconcile]${dry ? " (dry)" : ""} SKIP "${sequel.title}" ≠ "${canonical.title}" (${guard.reason}).`);
        continue;
      }

      const detected = detectSeason(sequel.title, kind);
      let maxSeason = 0;
      if (canonicalItem) {
        const agg = await prisma.mediaEpisode.aggregate({
          where: { media_item_id: canonicalItem.id },
          _max: { season_number: true },
        });
        maxSeason = agg._max?.season_number ?? 0;
      }
      // Películas: sin temporadas — todo va como T1 dentro de la misma tarjeta.
      // Duplicados con el mismo título/base son copias de la misma temporada,
      // no una temporada nueva. Solo una secuela sin marcador explícito usa la
      // siguiente temporada disponible.
      const sameIdentity = sameBase || guard.similarity >= 0.5;
      const season = kind === "movie"
        ? 1
        : detected > 1
          ? detected
          : sameIdentity
            ? 1
            : Math.max(1, maxSeason + 1);

      const lastEp = await prisma.episode.findFirst({
        where: { show_id: canonical.id },
        orderBy: { episode_number: "desc" },
        take: 1,
      });
      let nextNumber = (lastEp?.episode_number ?? 0) + 1;

      // 1) Mover episodios legacy con numeración continua.
      const sequelEps = await prisma.episode.findMany({
        where: { show_id: sequel.id },
        orderBy: { episode_number: "asc" },
      });
      let moved = 0;
      for (const ep of sequelEps) {
        if (!dry) {
          const dupe = ep.source_url
            ? await prisma.episode.findFirst({ where: { show_id: canonical.id, source_url: ep.source_url } })
            : null;
          if (!dupe) {
            await prisma.episode.create({
              data: { show_id: canonical.id, episode_number: nextNumber, title: ep.title, source_url: ep.source_url },
            });
          }
          nextNumber++;
        } else {
          nextNumber++;
        }
        moved++;
      }

      // 2) Mover fuentes multi-fuente al MediaItem canónico bajo `season`.
      // Si la obra canónica no tenía aún MediaItem, créalo antes de mover nada;
      // nunca se borra una secuela con fuentes sin un destino confirmado.
      if (!dry && !canonicalItem) {
        canonicalItem = await prisma.mediaItem.create({
          data: {
            normalized_title: canonical.normalized_title,
            base_normalized_title: canonical.base_normalized_title || canonical.normalized_title,
            title: canonical.title,
            tmdb_id: canonical.tmdb_id,
            kind,
            year: canonical.year,
            poster_url: canonical.poster_url,
          },
        });
      }
      if (!dry && canonicalItem) {
        const sequelItem = await prisma.mediaItem.findFirst({
          where: {
            id: { not: canonicalItem.id },
            OR: [
              ...(sequel.tmdb_id ? [{ tmdb_id: sequel.tmdb_id }] : []),
              { base_normalized_title: sBase, kind },
              { normalized_title: sequel.normalized_title, kind },
            ],
          },
        });
        if (sequelItem) {
          const seqMediaEps = await prisma.mediaEpisode.findMany({
            where: { media_item_id: sequelItem.id },
            include: { links: true },
          });
          for (const me of seqMediaEps) {
            const target = await prisma.mediaEpisode.upsert({
              where: {
                media_item_id_season_number_episode_number: {
                  media_item_id: canonicalItem.id,
                  season_number: season,
                  episode_number: me.episode_number,
                },
              },
              create: { media_item_id: canonicalItem.id, season_number: season, episode_number: me.episode_number },
              update: {},
            });
            for (const link of me.links) await copySourceLink(link, target.id);
          }
        }
      }

      // 3) Eliminar la secuela (MediaItem cascada → MediaEpisode+SourceLink; Show cascada → Episode).
      if (!dry) {
        const sequelItem = await prisma.mediaItem.findFirst({
          where: {
            ...(canonicalItem ? { id: { not: canonicalItem.id } } : {}),
            OR: [
              ...(sequel.tmdb_id ? [{ tmdb_id: sequel.tmdb_id }] : []),
              { base_normalized_title: sBase, kind },
              { normalized_title: sequel.normalized_title, kind },
            ],
          },
        });
        // Si existe un MediaItem con fuentes y no pudimos preparar destino,
        // abortar la eliminación para no perder datos.
        if (sequelItem && !canonicalItem) {
          summary.skipped.push({ canonical: canonical.title, merged: sequel.title, reason: "sin MediaItem canónico seguro" });
          continue;
        }
        if (sequelItem) await prisma.mediaItem.delete({ where: { id: sequelItem.id } });
        await prisma.show.delete({ where: { id: sequel.id } });
        summary.shows_deleted++;
      }

      summary.merges_done++;
      summary.episodes_moved += moved;
      summary.details.push({
        canonical: canonical.title,
        merged: sequel.title,
        season,
        episodes_moved: moved,
      });
      console.log(
        `[Reconcile]${dry ? " (dry)" : ""} "${sequel.title}" → "${canonical.title}" como T${season} (${moved} eps).`
      );
    }
  }

  return summary;
}

/**
 * Fusiona `MediaItem` duplicados que comparten TMDB pero no están vinculados
 * al mismo Show legacy. Es la segunda mitad de la reconciliación: sin ella,
 * el multiplexor seguiría viendo fuentes fragmentadas aunque los carteles ya
 * fueran una sola obra.
 */
export async function reconcileMediaItemsByTmdb(opts: { dryRun?: boolean } = {}): Promise<MediaItemReconcileSummary> {
  const dry = opts.dryRun !== false;
  const summary: MediaItemReconcileSummary = {
    groups_checked: 0,
    merges_done: 0,
    episodes_moved: 0,
    media_items_deleted: 0,
    dry_run: dry,
    details: [],
    skipped: [],
  };
  const mediaModel = prisma.mediaItem as any;
  if (typeof mediaModel.groupBy !== "function") return summary;

  const groups = await mediaModel.groupBy({
    by: ["tmdb_id"],
    where: { tmdb_id: { not: null } },
    _count: { _all: true },
    having: { tmdb_id: { _count: { gt: 1 } } },
  });
  summary.groups_checked = groups.length;

  for (const group of groups) {
    const items = await prisma.mediaItem.findMany({
      where: { tmdb_id: group.tmdb_id },
      orderBy: { created_at: "asc" },
      include: { episodes: { include: { links: true } } },
    });
    if (items.length < 2) continue;

    // Un entero TMDB puede repetirse entre namespaces movie/TV. Procesar cada
    // kind por separado y dejar constancia de los cruces que se descartan.
    const byKind = new Map<string, any[]>();
    for (const item of items) {
      const itemKind = String(item.kind || "movie");
      const key = new Set(["anime", "series"]).has(itemKind) ? "tv" : itemKind;
      const list = byKind.get(key) || [];
      list.push(item);
      byKind.set(key, list);
    }
    for (const [kind, sameKind] of byKind) {
      const canonical = sameKind[0];
      for (const duplicate of sameKind.slice(1)) {
        const guard = shouldAutoMerge(
          canonical.title,
          duplicate.title,
          kind,
          duplicate.title,
          [canonical.original_title].filter(Boolean) as string[],
          [duplicate.original_title].filter(Boolean) as string[],
        );
        if (!guard.ok) {
          summary.skipped.push({ canonical: canonical.title, merged: duplicate.title, reason: guard.reason });
          continue;
        }

        const detected = detectSeason(duplicate.title, kind);
        let moved = 0;
        for (const episode of duplicate.episodes || []) {
          // Si el título indica S2/S3 y el importador dejó la temporada en 1,
          // corregirla al mover; las temporadas explícitas ya se conservan.
          const season = detected > 1 && Number(episode.season_number) === 1
            ? detected
            : Number(episode.season_number) || 1;
          if (!dry) {
            const target = await prisma.mediaEpisode.upsert({
              where: {
                media_item_id_season_number_episode_number: {
                  media_item_id: canonical.id,
                  season_number: season,
                  episode_number: episode.episode_number,
                },
              },
              create: {
                media_item_id: canonical.id,
                season_number: season,
                episode_number: episode.episode_number,
              },
              update: {},
            });
            for (const link of episode.links || []) await copySourceLink(link, target.id);
          }
          moved++;
        }
        if (!dry) {
          await prisma.mediaItem.delete({ where: { id: duplicate.id } });
          summary.media_items_deleted++;
        }
        summary.merges_done++;
        summary.episodes_moved += moved;
        summary.details.push({ canonical: canonical.title, merged: duplicate.title, season: detected > 1 ? detected : 1, episodes_moved: moved });
      }
    }
  }
  return summary;
}

/** Utilidad: clave canónica rápida (por si se necesita depurar). */
export function titleKeyOf(title: string): string {
  return normalizeTitleKey(title);
}

/**
 * FUSIÓN MANUAL de dos obras concretas (para pares que las guardas de
 * similitud no se atreven a fusionar solo, p.ej. títulos en idiomas distintos
 * con el mismo tmdb_id). keep = la que queda; merge = la que se absorbe.
 * dryRun=true (default) solo reporta el plan.
 */
export async function mergeTwoShows(
  keepId: string,
  mergeId: string,
  opts: { dryRun?: boolean } = {}
): Promise<{ ok: boolean; detail: string; season?: number; episodes_moved?: number }> {
  const dry = opts.dryRun !== false;
  if (keepId === mergeId) return { ok: false, detail: "No puedes fusionar una obra consigo misma." };
  const keep = await prisma.show.findUnique({ where: { id: keepId } });
  const merge = await prisma.show.findUnique({ where: { id: mergeId } });
  if (!keep || !merge) return { ok: false, detail: "Alguna de las dos obras no existe." };

  const kind = (keep.category || "anime") as ContentKind;
  const cBase = keep.base_normalized_title || keep.normalized_title;
  const detected = detectSeason(merge.title, kind);

  let canonicalItem = await prisma.mediaItem.findFirst({
    where: { OR: [{ base_normalized_title: cBase, kind }, { normalized_title: keep.normalized_title, kind }] },
    orderBy: { created_at: "asc" },
  });
  let maxSeason = 0;
  if (canonicalItem) {
    const agg = await prisma.mediaEpisode.aggregate({
      where: { media_item_id: canonicalItem.id },
      _max: { season_number: true },
    });
    maxSeason = agg._max?.season_number ?? 0;
  }
  const season = kind === "movie" ? 1 : detected > 1 ? detected : Math.max(1, maxSeason + 1);

  const lastEp = await prisma.episode.findFirst({
    where: { show_id: keep.id },
    orderBy: { episode_number: "desc" },
    take: 1,
  });
  let nextNumber = (lastEp?.episode_number ?? 0) + 1;

  const mergeEps = await prisma.episode.findMany({ where: { show_id: merge.id }, orderBy: { episode_number: "asc" } });
  let moved = 0;
  for (const ep of mergeEps) {
    if (!dry) {
      const dupe = ep.source_url
        ? await prisma.episode.findFirst({ where: { show_id: keep.id, source_url: ep.source_url } })
        : null;
      if (!dupe) {
        await prisma.episode.create({
          data: { show_id: keep.id, episode_number: nextNumber, title: ep.title, source_url: ep.source_url },
        });
      }
      nextNumber++;
    } else {
      nextNumber++;
    }
    moved++;
  }

  if (!dry) {
    const mBase = merge.base_normalized_title || merge.normalized_title;
    const mergeItem = await prisma.mediaItem.findFirst({
      where: { OR: [{ base_normalized_title: mBase, kind }, { normalized_title: merge.normalized_title, kind }] },
    });
    if (canonicalItem && mergeItem) {
      const seqMediaEps = await prisma.mediaEpisode.findMany({
        where: { media_item_id: mergeItem.id },
        include: { links: true },
      });
      for (const me of seqMediaEps) {
        const target = await prisma.mediaEpisode.upsert({
          where: {
            media_item_id_season_number_episode_number: {
              media_item_id: canonicalItem.id,
              season_number: season,
              episode_number: me.episode_number,
            },
          },
          create: { media_item_id: canonicalItem.id, season_number: season, episode_number: me.episode_number },
          update: {},
        });
        for (const link of me.links) await copySourceLink(link, target.id);
      }
      await prisma.mediaItem.delete({ where: { id: mergeItem.id } });
    }
    await prisma.show.delete({ where: { id: merge.id } });
    console.log(`[Reconcile] FUSIÓN MANUAL: "${merge.title}" → "${keep.title}" como T${season} (${moved} eps).`);
  }

  return { ok: true, detail: dry ? `DRY: '${merge.title}' → '${keep.title}' como T${season} (${moved} eps).` : `Fusionado: '${merge.title}' → '${keep.title}' como T${season} (${moved} eps).`, season, episodes_moved: moved };
}
