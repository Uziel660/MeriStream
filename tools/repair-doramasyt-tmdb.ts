#!/usr/bin/env node
/**
 * Completa tmdb_id únicamente en MediaItems que tengan una fuente DoramasYT.
 *
 * La operación es conservadora y reanudable:
 * - primero hereda un TMDB ya confirmado cuando dos variantes comparten el
 *   mismo episodio DoramasYT;
 * - después consulta el resolvedor con confianza de TMDB usando título,
 *   aliases, año y tipo;
 * - --apply solo escribe resoluciones high que no contradicen el tipo local;
 * - todo queda en un informe JSON para revisar los casos medium/unresolved.
 */
import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { resolveTmdbIdentityCandidate, type IdentityKind, type TmdbIdentityResolution } from "../server/identity/tmdbIdentityResolver";

interface Options {
  apply: boolean;
  limit?: number;
  concurrency: number;
  afterId?: string;
  report?: string;
}

interface Row {
  id: string;
  title: string;
  original_title: string | null;
  year: number | null;
  kind: string;
  episodes: Array<{ links: Array<{ url: string }> }>;
}

interface Result {
  id: string;
  title: string;
  year: number | null;
  kind: string;
  tmdb_id: number | null;
  confidence: string | null;
  score: number | null;
  matched_alias: string | null;
  reasons: string[];
  action: "variant" | "applied" | "would_apply" | "review" | "unresolved" | "error";
  error?: string;
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const value = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const parsedLimit = Number(value("--limit"));
  const parsedConcurrency = Number(value("--concurrency"));
  return {
    apply: args.includes("--apply"),
    limit: Number.isInteger(parsedLimit) && parsedLimit > 0 ? parsedLimit : undefined,
    concurrency: Math.min(8, Math.max(1, Number.isInteger(parsedConcurrency) ? parsedConcurrency : 3)),
    afterId: value("--after-id"),
    report: value("--report"),
  };
}

function normalizeKey(value: string): string {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function variantKey(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const path = parsed.pathname
      .toLowerCase()
      .replace(/-latino(?=-episodio-)/g, "")
      .replace(/-castellano(?=-episodio-)/g, "")
      .replace(/-sub[-_]?espanol(?=-episodio-)/g, "");
    return `${parsed.hostname.toLowerCase()}${path}`;
  } catch {
    return normalizeKey(rawUrl);
  }
}

function validYear(value: unknown): number | null {
  const year = Number(value);
  const current = new Date().getFullYear();
  return Number.isInteger(year) && year >= 1900 && year <= current + 1 ? year : null;
}

function kindForTmdb(value: string): IdentityKind {
  return String(value || "").toLowerCase() === "movie" ? "movie" : "series";
}

function sourceAliases(row: Row): string[] {
  const values: string[] = [];
  const add = (value: unknown): void => {
    const text = String(value || "").trim();
    if (!text || normalizeKey(text).length < 2) return;
    const key = normalizeKey(text);
    if (!values.some((entry) => normalizeKey(entry) === key)) values.push(text);
  };

  add(row.title);
  add(row.title.replace(/\b(?:latino|castellano|sub[-_ ]?espanol|subtitulado)\b/gi, " "));
  add(row.original_title);
  for (const episode of row.episodes || []) {
    for (const link of episode.links || []) {
      try {
        const slug = new URL(link.url).pathname.split("/").filter(Boolean).pop() || "";
        add(slug.replace(/-episodio-\d+(?:-\d+)?$/i, "").replace(/-/g, " "));
      } catch {
        // A malformed locator must not stop the rest of the catalog.
      }
    }
  }
  return values.slice(0, 6);
}

function safeResolution(resolution: TmdbIdentityResolution | null): boolean {
  if (!resolution || resolution.confidence !== "high" || resolution.score < 0.84) return false;
  if (resolution.reasons.includes("year_mismatch") || resolution.reasons.includes("wrong_media_type")) return false;
  return true;
}

async function main(): Promise<void> {
  const options = parseArgs();
  const prisma = new PrismaClient();
  const results: Result[] = [];
  let variantLinks = 0;
  let applied = 0;
  let high = 0;
  let medium = 0;
  let unresolved = 0;
  let errors = 0;

  try {
    const allLinks = await prisma.sourceLink.findMany({
      where: { source_site: "doramasyt" },
      select: {
        url: true,
        media_episode: {
          select: {
            media_item: { select: { id: true, title: true, kind: true, tmdb_id: true } },
          },
        },
      },
    });

    const variantBuckets = new Map<string, Array<{ id: string; title: string; kind: string; tmdb_id: number | null }>>();
    for (const link of allLinks) {
      const item = link.media_episode.media_item;
      const bucket = variantBuckets.get(variantKey(link.url)) || [];
      bucket.push(item);
      variantBuckets.set(variantKey(link.url), bucket);
    }

    const inherited = new Map<string, number>();
    for (const bucket of variantBuckets.values()) {
      const targets = new Map<number, { kind: string }>();
      for (const item of bucket) {
        if (item.tmdb_id != null) targets.set(item.tmdb_id, { kind: item.kind });
      }
      if (targets.size !== 1) continue;
      const [tmdbId, target] = [...targets.entries()][0];
      for (const item of bucket) {
        if (item.tmdb_id == null && item.kind === target.kind) inherited.set(item.id, tmdbId);
      }
    }

    const rows = await prisma.mediaItem.findMany({
      where: {
        tmdb_id: null,
        ...(options.afterId ? { id: { gt: options.afterId } } : {}),
        episodes: { some: { links: { some: { source_site: "doramasyt" } } } },
      },
      orderBy: { id: "asc" },
      take: options.limit,
      select: {
        id: true,
        title: true,
        original_title: true,
        year: true,
        kind: true,
        episodes: {
          select: { links: { where: { source_site: "doramasyt" }, select: { url: true } } },
        },
      },
    }) as Row[];

    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < rows.length) {
        const row = rows[cursor++];
        try {
          const inheritedId = inherited.get(row.id);
          if (inheritedId) {
            if (options.apply) {
              const update = await prisma.mediaItem.updateMany({ where: { id: row.id, tmdb_id: null }, data: { tmdb_id: inheritedId } });
              if (update.count > 0) applied++;
            }
            variantLinks++;
            results.push({ id: row.id, title: row.title, year: row.year, kind: row.kind, tmdb_id: inheritedId, confidence: "high", score: 1, matched_alias: null, reasons: ["unique_episode_variant"], action: options.apply ? "variant" : "would_apply" });
            continue;
          }

          const resolution = await resolveTmdbIdentityCandidate({
            title: row.title,
            aliases: sourceAliases(row),
            year: validYear(row.year),
            kind: kindForTmdb(row.kind),
          });
          const safe = safeResolution(resolution);
          if (safe) {
            high++;
            if (options.apply) {
              const update = await prisma.mediaItem.updateMany({ where: { id: row.id, tmdb_id: null }, data: { tmdb_id: resolution!.tmdbId } });
              if (update.count > 0) applied++;
            }
            results.push({ id: row.id, title: row.title, year: row.year, kind: row.kind, tmdb_id: resolution!.tmdbId, confidence: resolution!.confidence, score: resolution!.score, matched_alias: resolution!.matchedAlias, reasons: resolution!.reasons, action: options.apply ? "applied" : "would_apply" });
          } else if (resolution) {
            medium++;
            results.push({ id: row.id, title: row.title, year: row.year, kind: row.kind, tmdb_id: resolution.tmdbId, confidence: resolution.confidence, score: resolution.score, matched_alias: resolution.matchedAlias, reasons: resolution.reasons, action: "review" });
          } else {
            unresolved++;
            results.push({ id: row.id, title: row.title, year: row.year, kind: row.kind, tmdb_id: null, confidence: null, score: null, matched_alias: null, reasons: [], action: "unresolved" });
          }
        } catch (error) {
          errors++;
          results.push({ id: row.id, title: row.title, year: row.year, kind: row.kind, tmdb_id: null, confidence: null, score: null, matched_alias: null, reasons: [], action: "error", error: String(error) });
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(options.concurrency, rows.length) }, () => worker()));
    results.sort((a, b) => a.id.localeCompare(b.id));

    const summary = {
      generatedAt: new Date().toISOString(),
      dryRun: !options.apply,
      scanned: rows.length,
      high,
      medium,
      unresolved,
      errors,
      variantLinks,
      applied,
      nextAfterId: rows.at(-1)?.id || null,
      results,
    };
    if (options.report) await writeFile(options.report, JSON.stringify(summary, null, 2), "utf8");
    console.log(JSON.stringify({ ...summary, results: undefined }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (!process.env.VITEST && process.argv.some((arg) => arg.endsWith("repair-doramasyt-tmdb.ts"))) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { normalizeKey, safeResolution, sourceAliases, variantKey };
