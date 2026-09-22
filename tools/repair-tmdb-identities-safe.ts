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
import { decodeHtmlEntities, normalizeTitleKey, parseRawTitle } from "../server/utils/titleNormalizer";

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
  rejectedHigh: number;
  inherited: number;
  mediumConfidence: number;
  unresolved: number;
  applied: number;
  errors: number;
  nextAfterShowId: string | null;
  nextAfterMediaId: string | null;
}

const PRIMARY_SOURCE_SITES = ["cinecalidad", "latanime", "gnula", "tioanime"];
const CURATED_TMDB_IDS: Record<string, number> = {
  corredoresdeljuego: 1263532,
  unaestrellarebeldeenelinfierno: 804252,
  juegodeterror: 72508,
  elsanador2: 1219548,
  lacaceriafinal: 1309770,
  laidentidaddeunnecio: 1466302,
  senalacustica: 1146910,
  cuandoelamoraparece: 1067821,
  gataodetalpalotalastilla: 1303236,
  girlsdorms1s2: 199315,
  freemovie4thefinalstroke: 738091,
  nekoparaanime: 95317,
  azurlaneminidrama: 91455,
  lasllamadas: 914243,
  undesenfrenadofindesemana: 13991,
  lamaestradelasbromastakagisanliveaction: 235913,
  doctorwhorescatedenochebuena: 239770,
  doctorwhorisitas: 239770,
  harleyquinnespecialdeunmuyproblematicosanvalentin: 74440,
  elhobbit3labatalladeloscincoejercitos: 122917,
  unicornwarsla: 587092,
  noesloquepiensas: 308402,
  alkhallatla: 318188,
  unatiendaparaasesinos: 215072,
  unavenidadealtura: 81044,
  ellayyoenelbanodemujeres: 88090,
  bakihanmas1s2: 129600,
  vecinosbarbaros: 1001736,
  coradale: 976226,
  enbuscadelanilloperdido: 911252,
  miradaasesina: 1200320,
  elpaseo8lalunadehiel: 1586841,
  shakerattleandroll17elorigendelmal: 1510795,
  suenosdecampeon: 1448170,
  unachicaenausten: 1221678,
  mentirasdeunninero: 1155123,
  ojosdeextrano: 948184,
  mensajesalsenordarcy: 1221673,
  quierotuamor2: 1214835,
  quierotuamor: 590401,
  cartassicilianas: 1148663,
  kantaraunaleyenda: 858485,
  elmisteriodelafamiliacarmen: 1363282,
  unapizcadeportugal: 1093765,
  juegodoloryamor: 1077902,
  loquehacemospordinero: 678416,
  noodiaras: 665139,
  rwbychibi2: 68415,
  rwbychibi3: 68415,
};

const CURATED_CATEGORY_OVERRIDES: Record<string, "movie" | "series" | "anime"> = {
  unaestrellarebeldeenelinfierno: "movie",
  lamaestradelasbromastakagisanliveaction: "series",
  doctorwhorescatedenochebuena: "series",
  doctorwhorisitas: "series",
  harleyquinnespecialdeunmuyproblematicosanvalentin: "series",
};

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
    onlyNone: args.includes("--only-none"),
    mediaOnly: args.includes("--media-only"),
    showsOnly: args.includes("--shows-only"),
    primaryOnly: args.includes("--primary-only"),
    limit: Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : undefined,
    concurrency: Math.min(8, Math.max(1, Number.isFinite(concurrencyRaw) ? Math.floor(concurrencyRaw) : 3)),
    afterShowId: value("--after-show-id"),
    afterMediaId: value("--after-media-id"),
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

function compatibleMediaKinds(kind: IdentityKind): string[] {
  if (kind === "anime") return ["anime", "series"];
  return [kind];
}

function compatibleYear(value: number | null, expected: number | null): boolean {
  if (!value || !expected) return true;
  return Math.abs(value - expected) <= 1;
}

function uniqueConfirmedTmdbIds(rows: Array<{ tmdb_id: number | null; title: string; normalized_title: string; base_normalized_title: string | null; year: number | null }>, titleKeys: string[], title: string, year: number | null): number[] {
  const requested = normalizeTitleKey(title);
  const exact = rows.filter((row) =>
    compatibleYear(row.year, year) &&
    (normalizeTitleKey(row.title) === requested || titleKeys.includes(row.normalized_title) || Boolean(row.base_normalized_title && titleKeys.includes(row.base_normalized_title))),
  );
  return [...new Set(exact.map((row) => row.tmdb_id).filter((id): id is number => Number.isInteger(id) && id > 0))];
}

/**
 * Las aliases de proveedores pueden estar contaminadas (por ejemplo, el
 * título visible pertenece a una obra y el alias japonés a otra). Una
 * coincidencia HIGH solo se puede aplicar automáticamente si coincide con el
 * título canónico del registro o proviene de un IMDb existente.
 */
function isSafeHighMatch(title: string, aliases: string[], resolution: TmdbIdentityResolution): boolean {
  const identityAliasKey = (value: string): string => normalizeTitleKey(
    parseRawTitle(decodeHtmlEntities(value)).canonical,
  );
  const allowedAliases = new Set([title, ...aliases].map(identityAliasKey));
  return resolution.confidence === "high" && (
    resolution.source === "imdb" ||
    (allowedAliases.has(identityAliasKey(resolution.matchedAlias)) && (
      resolution.reasons.includes("exact_title") || resolution.reasons.includes("unique_exact_year") || resolution.reasons.includes("unique_exact_title")
    ))
  );
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
    rejectedHigh: 0,
    inherited: 0,
    mediumConfidence: 0,
    unresolved: 0,
    applied: 0,
    errors: 0,
    nextAfterShowId: null,
    nextAfterMediaId: null,
  };

  try {
    const shows = opts.mediaOnly ? [] : await prisma.show.findMany({
      where: {
        tmdb_id: null,
        ...(opts.primaryOnly ? { source: { in: PRIMARY_SOURCE_SITES } } : {}),
        ...(opts.onlyNone ? { mal_id: null, anilist_id: null } : {}),
        ...(opts.afterShowId ? { id: { gt: opts.afterShowId } } : {}),
      },
      orderBy: { id: "asc" },
      take: opts.limit,
      select: {
        id: true,
        title: true,
        original_title: true,
        english_title: true,
        japanese_title: true,
        normalized_title: true,
        base_normalized_title: true,
        year: true,
        category: true,
      },
    });
    summary.nextAfterShowId = shows.at(-1)?.id || null;

    console.log(`[info] Analizando ${shows.length} shows sin TMDB... (Concurrencia: ${opts.concurrency})`);
    let showProcessed = 0;

    await mapConcurrent(shows, opts.concurrency, async (show) => {
      summary.considered++;
      showProcessed++;
      if (showProcessed % 10 === 0 || showProcessed === shows.length) {
        console.log(`[progreso] Shows procesados: ${showProcessed} / ${shows.length} (${show.title})`);
      }
      const kind = normalizeKind(show.category);
      const year = validYear(show.year);
      try {
        const curatedTmdbId = CURATED_TMDB_IDS[normalizeTitleKey(show.title)];
        if (curatedTmdbId) {
          summary.highConfidence++;
          const curatedCategory = CURATED_CATEGORY_OVERRIDES[normalizeTitleKey(show.title)];
          if (opts.apply) {
            const updated = await prisma.show.updateMany({
              where: { id: show.id, tmdb_id: null },
              data: { tmdb_id: curatedTmdbId, ...(curatedCategory ? { category: curatedCategory } : {}) },
            });
            if (updated.count > 0) summary.applied++;
          }
          report.push({
            model: "Show", id: show.id, title: show.title, year, kind, resolution: {
              tmdbId: curatedTmdbId,
              mediaType: "movie",
              title: show.title,
              originalTitle: show.original_title,
              year,
              score: 1,
              confidence: "high",
              matchedAlias: show.title,
              reasons: ["curated_external_mapping"],
              source: "tmdb-search",
            }, action: opts.apply ? "applied" : "would_apply",
          });
          return;
        }
        const titleKeys = uniqueAliases([
          show.title,
          show.normalized_title,
          show.base_normalized_title,
        ]);
        const linked = await prisma.show.findFirst({
          where: {
            id: { not: show.id },
            tmdb_id: { not: null },
            category: { in: compatibleShowCategories(kind) },
            ...(year ? { year } : {}),
            OR: [
              { normalized_title: { in: titleKeys } },
              ...(year ? [{ base_normalized_title: { in: titleKeys } }] : []),
            ],
          },
          select: { tmdb_id: true },
          orderBy: { created_at: "asc" },
        });
        if (linked?.tmdb_id) {
          summary.inherited++;
          if (opts.apply) {
            const updated = await prisma.show.updateMany({ where: { id: show.id, tmdb_id: null }, data: { tmdb_id: linked.tmdb_id } });
            if (updated.count > 0) summary.applied++;
          }
          report.push({
            model: "Show", id: show.id, title: show.title, year, kind, resolution: {
              tmdbId: linked.tmdb_id,
              mediaType: kind === "movie" ? "movie" : "tv",
              title: show.title,
              originalTitle: show.original_title,
              year,
              score: 1,
              confidence: "high",
              matchedAlias: show.title,
              reasons: ["inherited_from_confirmed_show"],
              source: "tmdb-search",
            }, action: opts.apply ? "inherited" : "would_inherit",
          });
          return;
        }

        // El catálogo canónico también puede contener la identidad que falta
        // en una fila Show legacy. Solo heredamos cuando el conjunto filtrado
        // deja un único TMDB; varias secuelas con el mismo nombre se revisan.
        const mediaCandidates = await prisma.mediaItem.findMany({
          where: {
            tmdb_id: { not: null },
            kind: { in: compatibleMediaKinds(kind) },
            OR: [
              { normalized_title: { in: titleKeys } },
              { base_normalized_title: { in: titleKeys } },
            ],
          },
          select: { tmdb_id: true, title: true, normalized_title: true, base_normalized_title: true, year: true },
          take: 20,
        });
        const mediaTmdbIds = uniqueConfirmedTmdbIds(mediaCandidates, titleKeys, show.title, year);
        if (mediaTmdbIds.length === 1) {
          const tmdbId = mediaTmdbIds[0];
          summary.inherited++;
          if (opts.apply) {
            const updated = await prisma.show.updateMany({ where: { id: show.id, tmdb_id: null }, data: { tmdb_id: tmdbId } });
            if (updated.count > 0) summary.applied++;
          }
          report.push({
            model: "Show", id: show.id, title: show.title, year, kind, resolution: {
              tmdbId,
              mediaType: kind === "movie" ? "movie" : "tv",
              title: show.title,
              originalTitle: show.original_title,
              year,
              score: 1,
              confidence: "high",
              matchedAlias: show.title,
              reasons: ["inherited_from_confirmed_media_item"],
              source: "tmdb-search",
            }, action: opts.apply ? "inherited" : "would_inherit",
          });
          return;
        }
        const resolution = await resolveTmdbIdentityCandidate({
          title: show.title,
          aliases: uniqueAliases([show.original_title, show.english_title, show.japanese_title]),
          year,
          kind,
        });
        if (resolution && isSafeHighMatch(show.title, uniqueAliases([show.original_title, show.english_title, show.japanese_title]), resolution)) {
          summary.highConfidence++;
          if (opts.apply) {
            const updated = await prisma.show.updateMany({ where: { id: show.id, tmdb_id: null }, data: { tmdb_id: resolution.tmdbId } });
            if (updated.count > 0) summary.applied++;
          }
          report.push({ model: "Show", id: show.id, title: show.title, year, kind, resolution, action: opts.apply ? "applied" : "would_apply" });
        } else if (resolution?.confidence === "high") {
          summary.rejectedHigh++;
          report.push({
            model: "Show", id: show.id, title: show.title, year: validYear(show.year), kind,
            resolution: { ...resolution, reasons: [...resolution.reasons, "canonical_title_mismatch"] },
            action: "review",
          });
        } else if (resolution?.confidence === "medium") {
          summary.mediumConfidence++;
          report.push({ model: "Show", id: show.id, title: show.title, year, kind, resolution, action: "review" });
        } else {
          summary.unresolved++;
          report.push({ model: "Show", id: show.id, title: show.title, year, kind, resolution, action: "unresolved" });
        }
      } catch (error) {
        summary.errors++;
        console.warn(`[identity] Show ${show.id} ${show.title}: ${String(error)}`);
      }
    });

    const remaining = opts.limit ? Math.max(0, opts.limit - shows.length) : undefined;
    const mediaItems = opts.showsOnly || remaining === 0 ? [] : await prisma.mediaItem.findMany({
      where: {
        tmdb_id: null,
        ...(opts.primaryOnly ? {
          episodes: { some: { links: { some: { source_site: { in: PRIMARY_SOURCE_SITES } } } } },
        } : {}),
        ...(opts.afterMediaId ? { id: { gt: opts.afterMediaId } } : {}),
      },
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
    summary.nextAfterMediaId = mediaItems.at(-1)?.id || null;

    console.log(`[info] Analizando ${mediaItems.length} media items sin TMDB... (Concurrencia: ${opts.concurrency})`);
    let mediaProcessed = 0;

    await mapConcurrent(mediaItems, opts.concurrency, async (item) => {
      summary.considered++;
      mediaProcessed++;
      if (mediaProcessed % 10 === 0 || mediaProcessed === mediaItems.length) {
        console.log(`[progreso] Media items procesados: ${mediaProcessed} / ${mediaItems.length} (${item.title})`);
      }
      const kind = normalizeKind(item.kind);
      const year = validYear(item.year);
      try {
        const titleKeys = [item.base_normalized_title, item.normalized_title].filter((value): value is string => Boolean(value));
        const linkedRows = titleKeys.length > 0 ? await prisma.show.findMany({
          where: {
            tmdb_id: { not: null },
            category: { in: compatibleShowCategories(kind) },
            ...(year ? { year } : {}),
            OR: [
              { base_normalized_title: { in: titleKeys } },
              { normalized_title: { in: titleKeys } },
            ],
          },
          select: { tmdb_id: true, title: true, normalized_title: true, base_normalized_title: true, year: true },
          take: 20,
        }) : [];
        const linkedIds = uniqueConfirmedTmdbIds(linkedRows, titleKeys, item.title, year);

        if (linkedIds.length === 1) {
          const linkedTmdbId = linkedIds[0];
          summary.inherited++;
          if (opts.apply) {
            const updated = await prisma.mediaItem.updateMany({ where: { id: item.id, tmdb_id: null }, data: { tmdb_id: linkedTmdbId } });
            if (updated.count > 0) summary.applied++;
          }
          report.push({
            model: "MediaItem", id: item.id, title: item.title, year, kind, resolution: {
              tmdbId: linkedTmdbId,
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
        if (resolution && isSafeHighMatch(item.title, uniqueAliases([item.original_title]), resolution)) {
          summary.highConfidence++;
          if (opts.apply) {
            const updated = await prisma.mediaItem.updateMany({ where: { id: item.id, tmdb_id: null }, data: { tmdb_id: resolution.tmdbId } });
            if (updated.count > 0) summary.applied++;
          }
          report.push({ model: "MediaItem", id: item.id, title: item.title, year, kind, resolution, action: opts.apply ? "applied" : "would_apply" });
        } else if (resolution?.confidence === "high") {
          summary.rejectedHigh++;
          report.push({
            model: "MediaItem", id: item.id, title: item.title, year, kind,
            resolution: { ...resolution, reasons: [...resolution.reasons, "canonical_title_mismatch"] },
            action: "review",
          });
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
