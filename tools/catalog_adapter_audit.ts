/**
 * Auditoría de solo lectura de adaptadores de catálogo.
 *
 * No escribe en Prisma ni marca fuentes como verificadas. Consulta una página
 * de catálogo por adaptador, deduplica sus tarjetas y prueba una muestra de
 * fichas/episodios para distinguir: directo nativo, embed (aún requiere
 * resolución), página canónica sin resolver y error de extracción.
 *
 * Uso: npx tsx tools/catalog_adapter_audit.ts [--samples 2] [--pages 2] [--timeout-ms 15000]
 */
import fs from "node:fs";
import path from "node:path";
import { getActivePresets, extractCatalogListing, scraperManager } from "../server/universalScraper";
import { classifySourceKind } from "../server/resolutionMetadata";
import { catalogPageFingerprint, dedupeCatalogItems, isRepeatedCatalogPage } from "../server/catalogIntegrity";
import { buildCatalogPageUrl } from "../server/catalogPagination";
import type { ExtractedCatalogItem } from "../server/types";

const args = process.argv.slice(2);
const numericArg = (name: string, fallback: number): number => {
  const index = args.indexOf(name);
  const value = index >= 0 ? Number(args[index + 1]) : fallback;
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
};

const sampleLimit = Math.min(4, numericArg("--samples", 2));
const timeoutMs = Math.min(30_000, numericArg("--timeout-ms", 15_000));
const pageLimit = Math.min(8, numericArg("--pages", 2));

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout:${label}`)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function hostname(url: string): string | null {
  try { return new URL(url).hostname; } catch { return null; }
}

function classifyUrls(urls: string[]): { direct: number; embed: number; page: number; ephemeral: number } {
  const unique = [...new Set(urls.filter((url) => typeof url === "string" && url.trim()))];
  return unique.reduce((counts, url) => {
    const kind = classifySourceKind(url);
    if (kind === "ephemeral_direct") counts.ephemeral++;
    else if (kind === "stable_direct") counts.direct++;
    else if (kind === "embed") counts.embed++;
    else counts.page++;
    return counts;
  }, { direct: 0, embed: 0, page: 0, ephemeral: 0 });
}

interface DetailProbe {
  url: string;
  status: "ok" | "error";
  title?: string;
  episode_count?: number;
  probed_targets?: number;
  stream_counts?: { direct: number; embed: number; page: number; ephemeral: number };
  error?: string;
}

interface AdapterAudit {
  preset_id: string;
  adapter_id: string;
  category: string;
  catalog_url: string;
  catalog_status: "ok" | "empty" | "error";
  pages_checked: number;
  page_errors: number;
  repeated_pages: number;
  raw_items: number;
  unique_items: number;
  invalid_items: number;
  sample_details: DetailProbe[];
  elapsed_ms: number;
  error?: string;
}

async function probeDetail(item: ExtractedCatalogItem, adapterId: string): Promise<DetailProbe> {
  try {
    const analysis = await withTimeout(scraperManager.analyze(item.url, "detail", adapterId), `detail:${item.url}`);
    const episodes = Array.isArray(analysis.episodes) ? analysis.episodes : [];
    const candidates = [
      item.url,
      ...(analysis.detected_streams || []),
      ...episodes.flatMap((episode) => [episode.url, ...(episode.sources || []).map((source) => source.url)]),
    ].filter((url): url is string => typeof url === "string" && Boolean(url.trim()));
    // En series, la ficha casi siempre contiene páginas de episodio y no el
    // stream. Probamos la ficha más hasta dos episodios para no confundir
    // “HTML encontrado” con una extracción reproducible.
    const targets = [...new Set([
      item.url,
      ...episodes.slice(0, 2).map((episode) => episode.url),
    ].filter((url): url is string => typeof url === "string" && Boolean(url.trim())))];
    const streamUrls = [...candidates];
    for (const target of targets) {
      const extraction = await withTimeout(scraperManager.extractStream(target, adapterId), `stream:${target}`);
      streamUrls.push(extraction.stream_url, ...(extraction.all_available_streams || []));
    }
    return {
      url: item.url,
      status: "ok",
      title: analysis.title || item.title,
      episode_count: episodes.length,
      probed_targets: targets.length,
      stream_counts: classifyUrls(streamUrls),
    };
  } catch (error) {
    return { url: item.url, status: "error", error: String((error as Error)?.message || error) };
  }
}

async function auditPreset(preset: ReturnType<typeof getActivePresets>[number]): Promise<AdapterAudit> {
  const started = Date.now();
  const adapter = scraperManager.getAdapter(preset.example_url);
  try {
    const pageItems: ExtractedCatalogItem[][] = [];
    const pageErrors: string[] = [];
    let previousFingerprint: string | undefined;
    let repeatedPages = 0;
    for (let page = 1; page <= pageLimit; page++) {
      const pageUrl = page === 1 ? preset.example_url : buildCatalogPageUrl(preset.example_url, page);
      try {
        const rawPage = await withTimeout(extractCatalogListing(pageUrl, adapter.id), `catalog:${preset.id}:${page}`);
        const current = dedupeCatalogItems(rawPage || []) as ExtractedCatalogItem[];
        if (isRepeatedCatalogPage(current, previousFingerprint)) repeatedPages++;
        const fingerprint = catalogPageFingerprint(current);
        if (fingerprint) previousFingerprint = fingerprint;
        pageItems.push(current);
        // An empty page is a valid end marker. Do not issue unnecessary calls.
        if (current.length === 0) break;
      } catch (error) {
        pageErrors.push(String((error as Error)?.message || error));
        pageItems.push([]);
        if (page === 1) throw error;
      }
    }
    const raw = pageItems.flat();
    const items = dedupeCatalogItems(raw) as ExtractedCatalogItem[];
    const probes = [];
    for (const item of items.slice(0, sampleLimit)) {
      probes.push(await probeDetail(item, adapter.id));
    }
    return {
      preset_id: preset.id,
      adapter_id: adapter.id,
      category: preset.category,
      catalog_url: preset.example_url,
      catalog_status: raw.length > 0 ? "ok" : pageErrors.length > 0 ? "error" : "empty",
      pages_checked: pageItems.length,
      page_errors: pageErrors.length,
      repeated_pages: repeatedPages,
      raw_items: raw.length,
      unique_items: items.length,
      invalid_items: items.filter((item) => !hostname(item.url)).length,
      sample_details: probes,
      elapsed_ms: Date.now() - started,
    };
  } catch (error) {
    return {
      preset_id: preset.id,
      adapter_id: adapter.id,
      category: preset.category,
      catalog_url: preset.example_url,
      catalog_status: "error",
      raw_items: 0,
      unique_items: 0,
      invalid_items: 0,
      sample_details: [],
      pages_checked: 0,
      page_errors: 1,
      repeated_pages: 0,
      elapsed_ms: Date.now() - started,
      error: String((error as Error)?.message || error),
    };
  }
}

function toMarkdown(report: { generated_at: string; options: object; adapters: AdapterAudit[] }): string {
  const lines = [
    `# Auditoría de adaptadores de catálogo`,
    `Generado: ${report.generated_at}`,
    "",
    "Solo lectura. Un embed cuenta como extracción encontrada, no como reproducción nativa verificada.",
    "",
    "| Preset | Adaptador | Catálogo | Tarjetas únicas | Páginas | Repetidas | Muestras OK | Directos | Embeds | Páginas HTML | Errores |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|",
  ];
  for (const entry of report.adapters) {
    const probes = entry.sample_details;
    const totals = probes.reduce((sum, probe) => ({
      direct: sum.direct + (probe.stream_counts?.direct || 0),
      embed: sum.embed + (probe.stream_counts?.embed || 0),
      page: sum.page + (probe.stream_counts?.page || 0),
      ephemeral: sum.ephemeral + (probe.stream_counts?.ephemeral || 0),
    }), { direct: 0, embed: 0, page: 0, ephemeral: 0 });
    lines.push(`| ${entry.preset_id} | ${entry.adapter_id} | ${entry.catalog_status} | ${entry.unique_items} | ${entry.pages_checked} | ${entry.repeated_pages} | ${probes.filter((probe) => probe.status === "ok").length}/${probes.length} | ${totals.direct} | ${totals.embed} | ${totals.page} | ${entry.error || ""} |`);
  }
  lines.push("", "## Detalle", "", "```json", JSON.stringify(report.adapters, null, 2), "```", "");
  return lines.join("\n");
}

async function main(): Promise<void> {
  // Auditar todos los presets activos, incluido TubePelis. La exclusión que
  // existía aquí era histórica y dejaba fuera un proveedor requerido por el
  // catálogo real.
  const presets = getActivePresets().filter((preset) => preset.category !== "direct");
  const adapters: AdapterAudit[] = [];
  for (const preset of presets) {
    console.log(`[catalog-audit] ${preset.id} → ${preset.example_url}`);
    const result = await auditPreset(preset);
    adapters.push(result);
    console.log(`[catalog-audit] ${result.catalog_status} items=${result.unique_items} elapsed=${result.elapsed_ms}ms`);
  }

  const report = {
    generated_at: new Date().toISOString(),
    options: { sampleLimit, timeoutMs, pageLimit, excluded: [] },
    adapters,
  };
  const outputDir = path.join(process.cwd(), "docs", "workstreams");
  fs.mkdirSync(outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(outputDir, `catalog_adapter_audit_${stamp}.json`), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outputDir, `catalog_adapter_audit_${stamp}.md`), toMarkdown(report));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(`[catalog-audit] fatal: ${String((error as Error)?.message || error)}`);
  process.exitCode = 1;
});
