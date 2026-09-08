#!/usr/bin/env node
/**
 * Rellena SOLO tmdb_id faltantes usando el resolvedor con confianza explícita.
 *
 * - dry-run por defecto
 * - --apply escribe únicamente candidatos HIGH
 * - candidatos MEDIUM se guardan en el reporte para revisión manual
 * - nunca reemplaza un tmdb_id existente
 * - MediaItem hereda primero una identidad ya confirmada de Show cuando título,
 *   año y tipo son compatibles; así evitamos llamadas externas duplicadas.
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { resolveTmdbIdentityCandidate, type IdentityKind, type TmdbIdentityResolution } from "../server/identity/tmdbIdentityResolver";

interface ReportEntry {
  model: "Show" | "MediaItem";
  id: string;
  title: string;
  year: number | null;
  kind: IdentityKind;
  resolution: TmdbIdentityResolution | null;
  action: "applied" | "would_apply" | "review" | "unresolved" | "inherited" | "would_inherit";
}

interface Summary {
  dryRun: boolean;
  considered: number;
  highConfidence: number;
  inherited: number;
  mediumConfidence: number;
  unresolved: number;
  applied: number;
  errors: number;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const value = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const limitRaw = Number(value("--limit"));
  const concurrencyRaw = Number(value("--concurrency"));
  return {
    apply: args.includes("--apply"),
    limit: Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : undefined,
    concurrency: Math.min(8, Math.max(1, Number.isFinite(concurrencyRaw) ? Math.floor(concurrencyRaw) : 3)),
    reportFile: value("--report"),
  };
}

function normalizeKind(value: unknown): IdentityKind {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "anime" || raw === "donghua") return "anime";
  if (["series", "serie", "tv", "dorama", "drama", "kdrama"].includes(raw)) return "series";
  return "movie";
}

function uniqueAliases(values: unknown[]): string[] {
  const seen = new Set<string>();
  return values.flatMap((value) => {
    const text = typeof value === "string" ? value.trim() : "";
    const key = text.toLowerCase();
    if (!text || seen.has(key)) return [];
    seen.add(key);
    return [text];
  });
}

function validYear(value: unknown): number | null {
  const year = Number(value);
  return Number.isInteger(year) && year >= 1900 && year <= 2100 ? year : null;
}

function compatibleShowCategories(kind: IdentityKind): string[] {
  if (kind === "anime") return ["anime", "series"];
  if (kind === "series") return ["series", "tv", "dorama", "drama", "kdrama"];
  return ["movie", "pelicula", "película"];
}

async function writeReport(target: string | undefined, summary: Summary, entries: ReportEntry[]): Promise<void> {
  if (!target) return;
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const absolute = path.resolve(target);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, JSON.stringify({ generatedAt: new Date().toISOString(), summary, entries }, null, 2), "utf8");
}

async function mapConcurrent<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

async function main(): Promise<void> {
  const opts = parseArgs();
  const prisma = new PrismaClient();
  const report: ReportEntry[] = [];
  const summary: Summary = {
    dryRun: !opts.apply,
    considered: 0,
    highConfidence: 0,
    inherited: 0,
    mediumConfidence: 0,
    unresolved: 0,
    applied: 0,
    errors: 0,
  };

  try {
    const shows = await prisma.show.findMany({
      where: { tmdb_id: null },
      orderBy: { id: "asc" },
      take: opts.limit,
      select: {
        id: true,
        title: true,
        original_title: true,
        english_title: true,
        japanese_title: true,
        year: true,
        category: true,
      },
    });

    await mapConcurrent(shows, opts.concurrency, async (show) => {
      summary.considered++;
      const kind = normalizeKind(show.category);
      try {
        const resolution = await resolveTmdbIdentityCandidate({
          title: show.title,
          aliases: uniqueAliases([show.original_title, show.english_title, show.japanese_title]),
          year: validYear(show.year),
          kind,
        });
        if (resolution?.confidence === "high") {
          summary.highConfidence++;
          if (opts.apply) {
            const updated = await prisma.show.updateMany({ where: { id: show.id, tmdb_id: null }, data: { tmdb_id: resolution.tmdbId } });
            if (updated.count > 0) summary.applied++;
          }
          report.push({ model: "Show", id: show.id, title: show.title, year: validYear(show.year), kind, resolution, action: opts.apply ? "applied" : "would_apply" });
        } else if (resolution?.confidence === "medium") {
          summary.mediumConfidence++;
          report.push({ model: "Show", id: show.id, title: show.title, year: validYear(show.year), kind, resolution, action: "review" });
        } else {
          summary.unresolved++;
          report.push({ model: "Show", id: show.id, title: show.title, year: validYear(show.year), kind, resolution, action: "unresolved" });
        }
      } catch (error) {
        summary.errors++;
        console.warn(`[identity] Show ${show.id} ${show.title}: ${String(error)}`);
      }
    });

    const remaining = opts.limit ? Math.max(0, opts.limit - shows.length) : undefined;
    const mediaItems = remaining === 0 ? [] : await prisma.mediaItem.findMany({
      where: { tmdb_id: null },
      orderBy: { id: "asc" },
      take: remaining,
      select: {
        id: true,
        title: true,
        original_title: true,
        normalized_title: true,
        base_normalized_title: true,
        year: true,
        kind: true,
      },
    });

    await mapConcurrent(mediaItems, opts.concurrency, async (item) => {
      summary.considered++;
      const kind = normalizeKind(item.kind);
      const year = validYear(item.year);
      try {
        const titleKeys = [item.base_normalized_title, item.normalized_title].filter((value): value is string => Boolean(value));
        const linked = titleKeys.length > 0 ? await prisma.show.findFirst({
          where: {
            tmdb_id: { not: null },
            category: { in: compatibleShowCategories(kind) },
            ...(year ? { year } : {}),
            OR: [
              { base_normalized_title: { in: titleKeys } },
              { normalized_title: { in: titleKeys } },
            ],
          },
          select: { tmdb_id: true },
          orderBy: { created_at: "asc" },
        }) : null;

        if (linked?.tmdb_id) {
          summary.inherited++;
          if (opts.apply) {
            const updated = await prisma.mediaItem.updateMany({ where: { id: item.id, tmdb_id: null }, data: { tmdb_id: linked.tmdb_id } });
            if (updated.count > 0) summary.applied++;
          }
          report.push({
            model: "MediaItem", id: item.id, title: item.title, year, kind, resolution: {
              tmdbId: linked.tmdb_id,
              mediaType: kind === "movie" ? "movie" : "tv",
              title: item.title,
              originalTitle: item.original_title,
              year,
              score: 1,
              confidence: "high",
              matchedAlias: item.title,
              reasons: ["inherited_from_confirmed_show"],
              source: "tmdb-search",
            }, action: opts.apply ? "inherited" : "would_inherit",
          });
          return;
        }

        const resolution = await resolveTmdbIdentityCandidate({
          title: item.title,
          aliases: uniqueAliases([item.original_title]),
          year,
          kind,
        });
        if (resolution?.confidence === "high") {
          summary.highConfidence++;
          if (opts.apply) {
            const updated = await prisma.mediaItem.updateMany({ where: { id: item.id, tmdb_id: null }, data: { tmdb_id: resolution.tmdbId } });
            if (updated.count > 0) summary.applied++;
          }
          report.push({ model: "MediaItem", id: item.id, title: item.title, year, kind, resolution, action: opts.apply ? "applied" : "would_apply" });
        } else if (resolution?.confidence === "medium") {
          summary.mediumConfidence++;
          report.push({ model: "MediaItem", id: item.id, title: item.title, year, kind, resolution, action: "review" });
        } else {
          summary.unresolved++;
          report.push({ model: "MediaItem", id: item.id, title: item.title, year, kind, resolution, action: "unresolved" });
        }
      } catch (error) {
        summary.errors++;
        console.warn(`[identity] MediaItem ${item.id} ${item.title}: ${String(error)}`);
      }
    });

    await writeReport(opts.reportFile, summary, report);
    console.log(JSON.stringify(summary, null, 2));
    if (!opts.apply) console.log("Dry-run: usa --apply para escribir únicamente coincidencias HIGH.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
