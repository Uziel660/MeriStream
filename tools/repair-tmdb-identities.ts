#!/usr/bin/env node
/**
 * Repara la identidad TMDB del catálogo sin tocar enlaces ni borrar obras.
 *
 * Por defecto es simulación. Con --apply rellena IDs nulos y, en la fase de
 * conflictos, reemplaza solo los IDs que una revalidación textual confirme.
 * Con --missing-only se omite la fase de conflictos y sólo se procesan
 * registros sin ID (útil para una pasada de recuperación sin tocar IDs sanos).
 * El cursor permite detener/reanudar el proceso sin repetir los registros ya
 * confirmados. La concurrencia está limitada para no saturar TMDB ni Postgres.
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { resolveTmdbIdentity } from "../server/metadataEngine";
import { normalizeTitleKey } from "../server/utils/titleNormalizer";

type Cursor = {
  phase: "shows" | "conflicts" | "media_items" | "done";
  showIndex: number;
  conflictIndex: number;
  mediaIndex: number;
  updatedAt: string;
};

type Summary = {
  dry_run: boolean;
  shows_considered: number;
  shows_updated: number;
  media_items_considered: number;
  media_items_updated: number;
  unresolved: number;
  errors: Array<{ kind: string; id: string; title: string; error: string }>;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readCursor(file: string | undefined): Promise<Cursor> {
  if (!file) return { phase: "shows", showIndex: 0, conflictIndex: 0, mediaIndex: 0, updatedAt: new Date().toISOString() };
  try {
    const raw = await import("node:fs/promises").then((fs) => fs.readFile(file, "utf8"));
    const parsed = JSON.parse(raw) as Partial<Cursor>;
    return {
      phase: parsed.phase === "conflicts" || parsed.phase === "media_items" || parsed.phase === "done" ? parsed.phase : "shows",
      showIndex: Math.max(0, Number(parsed.showIndex) || 0),
      conflictIndex: Math.max(0, Number(parsed.conflictIndex) || 0),
      mediaIndex: Math.max(0, Number(parsed.mediaIndex) || 0),
      updatedAt: new Date().toISOString(),
    };
  } catch {
    return { phase: "shows", showIndex: 0, conflictIndex: 0, mediaIndex: 0, updatedAt: new Date().toISOString() };
  }
}

async function writeCursor(file: string | undefined, cursor: Cursor): Promise<void> {
  if (!file) return;
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const target = path.resolve(file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp.${Date.now()}`;
  const payload = JSON.stringify({ ...cursor, updatedAt: new Date().toISOString() }, null, 2);
  await fs.writeFile(tmp, payload, "utf8");
  try {
    await fs.rename(tmp, target);
  } catch (error: any) {
    // Windows puede rechazar el reemplazo atómico si un antivirus/editor
    // mantiene abierto el cursor. El fallback sigue escribiendo únicamente
    // este archivo pequeño y deja el temporal recuperable si también falla.
    if (error?.code !== "EPERM" && error?.code !== "EEXIST") throw error;
    await fs.writeFile(target, payload, "utf8");
    await fs.rm(tmp, { force: true });
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const value = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const parsedLimit = Number(value("--limit"));
  const parsedConcurrency = Number(value("--concurrency"));
  return {
    apply: args.includes("--apply"),
    missingOnly: args.includes("--missing-only"),
    limit: Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.floor(parsedLimit) : undefined,
    // TMDB permite ráfagas moderadas; ocho workers mantienen la máquina
    // ocupada sin acercarse al límite público de la API. El proceso es
    // reanudable mediante cursor y cualquier error queda registrado.
    concurrency: Math.min(12, Math.max(1, Number.isFinite(parsedConcurrency) ? Math.floor(parsedConcurrency) : 2)),
    cursorFile: value("--cursor-file"),
    reportFile: value("--report"),
  };
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const prisma = new PrismaClient();
  const cursor = await readCursor(opts.cursorFile);
  const summary: Summary = {
    dry_run: !opts.apply,
    shows_considered: 0,
    shows_updated: 0,
    media_items_considered: 0,
    media_items_updated: 0,
    unresolved: 0,
    errors: [],
  };

  try {
    // Sin cursor podemos filtrar los faltantes y terminar rápido. Cuando el
    // usuario pide checkpoints, conservamos la lista completa para que una
    // actualización no desplace el índice y salte filas al reanudar.
    const missingOnlyWhere = opts.missingOnly && !opts.cursorFile ? { tmdb_id: null } : {};
    const shows = await prisma.show.findMany({
      where: missingOnlyWhere,
      orderBy: { id: "asc" },
      select: {
        id: true,
        title: true,
        category: true,
        year: true,
        tmdb_id: true,
        normalized_title: true,
        original_title: true,
        english_title: true,
        japanese_title: true,
      },
    });
    const mediaItems = await prisma.mediaItem.findMany({
      // La pasada completa conserva la lectura de todos para poder
      // heredar/revalidar identidades compartidas con Shows legacy.
      where: missingOnlyWhere,
      orderBy: { id: "asc" },
      select: { id: true, title: true, kind: true, year: true, normalized_title: true, base_normalized_title: true, tmdb_id: true },
    });

    // Solo revalidamos IDs que están compartidos por títulos incompatibles.
    // Esto corrige contaminaciones históricas sin reinterpretar todo el catálogo.
    const duplicateGroups = await prisma.show.groupBy({
      by: ["tmdb_id"],
      where: { tmdb_id: { not: null } },
      _count: { _all: true },
      having: { tmdb_id: { _count: { gt: 1 } } },
    });
    const conflictIds = duplicateGroups.map((group) => group.tmdb_id).filter((id): id is number => Number.isInteger(id));
    const conflictShows = conflictIds.length > 0
      ? await prisma.show.findMany({
          where: { tmdb_id: { in: conflictIds } },
          orderBy: { id: "asc" },
          select: {
            id: true,
            title: true,
            category: true,
            year: true,
            tmdb_id: true,
            original_title: true,
            english_title: true,
            japanese_title: true,
          },
        })
      : [];

    const maxRecords = opts.limit ?? Number.POSITIVE_INFINITY;
    const resolveOne = async (
      kind: "show" | "media_item",
      row: {
        id: string;
        title: string;
        category?: string | null;
        kind?: string;
        year?: number | null;
        normalized_title?: string;
        base_normalized_title?: string | null;
        original_title?: string | null;
        english_title?: string | null;
        japanese_title?: string | null;
        tmdb_id?: number | null;
      },
      revalidateExisting = false,
    ): Promise<number | null> => {
      if (kind === "media_item") {
        // Un MediaItem suele tener un Show legacy equivalente. Reutilizar su
        // identidad evita miles de llamadas repetidas a TMDB y mantiene ambos
        // modelos alineados para el multiplexor. Primero respetamos el tipo
        // local y, si el importador lo clasificó distinto (anime/tv/series),
        // hacemos un segundo intento por identidad y año sin esa etiqueta.
        const titleOr = [
          ...(row.base_normalized_title ? [{ base_normalized_title: row.base_normalized_title }] : []),
          ...(row.normalized_title ? [{ normalized_title: row.normalized_title }] : []),
        ];
        const yearFilter = row.year && row.year > 0 ? { year: row.year } : {};
        let linkedShow = titleOr.length > 0
          ? await prisma.show.findFirst({
              where: { tmdb_id: { not: null }, category: row.kind || "movie", OR: titleOr },
              select: { tmdb_id: true },
              orderBy: { created_at: "asc" },
            })
          : null;
        if (!linkedShow && titleOr.length > 0) {
          linkedShow = await prisma.show.findFirst({
            where: { tmdb_id: { not: null }, ...yearFilter, OR: titleOr },
            select: { tmdb_id: true },
            orderBy: { created_at: "asc" },
          });
        }
        const inheritedId = linkedShow?.tmdb_id;
        if (Number.isInteger(inheritedId) && inheritedId! > 0) {
          if (opts.apply) await prisma.mediaItem.updateMany({ where: { id: row.id, NOT: { tmdb_id: inheritedId } }, data: { tmdb_id: inheritedId } });
          return inheritedId;
        }
        if (row.tmdb_id && !revalidateExisting) return row.tmdb_id;
      }
      if (kind === "show" && row.tmdb_id && !revalidateExisting) return row.tmdb_id;
      const hint = kind === "show" ? row.category || "anime" : row.kind || "movie";
      const aliases = [row.title, row.original_title, row.english_title, row.japanese_title]
        .map((value) => String(value || "").trim())
        .filter((value, index, values) => value && values.findIndex((candidate) => candidate.toLowerCase() === value.toLowerCase()) === index)
        .slice(0, 4);
      if (aliases.length === 0 || normalizeTitleKey(aliases[0]).length < 2) return null;
      let tmdbId: number | null = null;
      for (const alias of aliases) {
        const query = row.year && row.year > 0 ? `${alias} ${row.year}` : alias;
        const candidateId = await resolveTmdbIdentity(query, hint as any);
        if (candidateId) {
          tmdbId = candidateId;
          break;
        }
      }
      if (!Number.isInteger(tmdbId) || tmdbId <= 0) return null;
      if (opts.apply) {
        if (kind === "show") {
          await prisma.show.updateMany({
            where: revalidateExisting ? { id: row.id, tmdb_id: row.tmdb_id ?? undefined } : { id: row.id, tmdb_id: null },
            data: { tmdb_id: tmdbId },
          });
        } else {
          await prisma.mediaItem.updateMany({
            where: revalidateExisting ? { id: row.id, tmdb_id: row.tmdb_id ?? undefined } : { id: row.id, tmdb_id: null },
            data: { tmdb_id: tmdbId },
          });
        }
      }
      return tmdbId;
    };

    const runPhase = async <T extends {
      id: string;
      title: string;
      category?: string | null;
      kind?: string;
      year?: number | null;
      original_title?: string | null;
      english_title?: string | null;
      japanese_title?: string | null;
      normalized_title?: string;
      base_normalized_title?: string | null;
      tmdb_id?: number | null;
    }>(
      kind: "show" | "media_item",
      rows: T[],
      start: number,
      revalidateExisting = false,
    ): Promise<number> => {
      let index = start;
      while (index < rows.length && index - start < maxRecords) {
        const batch = rows.slice(index, Math.min(rows.length, index + opts.concurrency));
        await Promise.all(batch.map(async (row) => {
          if (kind === "show") summary.shows_considered++;
          else summary.media_items_considered++;
          try {
            const previousId = row.tmdb_id ?? null;
            const resolved = await resolveOne(kind, row, revalidateExisting);
            if (resolved) {
              const changed = previousId == null || (revalidateExisting && previousId !== resolved);
              if (changed && kind === "show") summary.shows_updated++;
              if (changed && kind === "media_item") summary.media_items_updated++;
            } else if (previousId == null) {
              summary.unresolved++;
            }
          } catch (error) {
            summary.errors.push({ kind, id: row.id, title: row.title, error: String(error) });
          }
        }));
        index += batch.length;
        if (index % 25 === 0 || index === rows.length) {
          console.log(`[TMDB] ${kind}: ${index}/${rows.length} · actual ${batch[batch.length - 1]?.title || ""}`);
      }
      if (opts.cursorFile) {
        if (kind === "show") {
          // La fase de conflictos también recorre Shows, pero necesita su
          // propio checkpoint: si se mezcla con showIndex, una interrupción
          // obliga a repetir toda la revalidación de IDs duplicados.
          if (revalidateExisting) cursor.conflictIndex = index;
          else cursor.showIndex = index;
        } else {
          cursor.mediaIndex = index;
        }
        await writeCursor(opts.cursorFile, cursor);
      }
        // Espaciado pequeño solo cuando el lote hizo llamadas externas. Los
        // miles de filas ya identificadas se recorren sin introducir minutos
        // de espera artificial en la reparación reanudable.
        const batchNeedsExternal = batch.some((row) => {
          const hasId = Boolean(row.tmdb_id);
          return kind === "show" ? !hasId || revalidateExisting : !hasId;
        });
        if (batchNeedsExternal) await sleep(150);
        if (summary.shows_considered + summary.media_items_considered >= maxRecords) break;
      }
      return index;
    };

    if (cursor.phase === "shows") {
      const nextShow = await runPhase("show", shows, cursor.showIndex);
      cursor.showIndex = nextShow;
      if (nextShow >= shows.length) cursor.phase = opts.missingOnly ? "media_items" : "conflicts";
      await writeCursor(opts.cursorFile, cursor);
    }
    if (!opts.missingOnly && cursor.phase === "conflicts" && summary.shows_considered + summary.media_items_considered < maxRecords) {
      const nextConflict = await runPhase("show", conflictShows, cursor.conflictIndex, true);
      cursor.conflictIndex = nextConflict;
      if (nextConflict >= conflictShows.length) cursor.phase = "media_items";
      await writeCursor(opts.cursorFile, cursor);
    }
    if (cursor.phase === "media_items" && summary.shows_considered + summary.media_items_considered < maxRecords) {
      const nextMedia = await runPhase("media_item", mediaItems, cursor.mediaIndex);
      cursor.mediaIndex = nextMedia;
      cursor.phase = "done";
      await writeCursor(opts.cursorFile, cursor);
    }

    if (opts.reportFile) {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const target = path.resolve(opts.reportFile);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, JSON.stringify({ ...summary, cursor }, null, 2), "utf8");
    }
    console.log(JSON.stringify({ ...summary, cursor }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (!process.env.VITEST && process.argv.some((arg) => arg.endsWith("repair-tmdb-identities.ts"))) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
