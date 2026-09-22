// tools/audit_stream_sources.ts
import { PrismaClient } from "@prisma/client";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseStreamExpiry } from "../server/resolutionMetadata";

export interface AuditStreamSourcesOptions {
  batchSize?: number;
  limit?: number;
  reportPath?: string;
  jsonOutput?: boolean;
  prismaClient?: PrismaClient;
  now?: number;
}

export interface StreamSourceAuditReport {
  timestamp: string;
  summary: {
    total_legacy_episodes: number;
    total_source_links: number;
    stable_direct: number;
    signed_valid: number;
    signed_expired: number;
    expired_with_canonical_sister: number;
    expired_without_recoverable_source: number;
  };
  breakdown_by_host: Record<string, number>;
  breakdown_by_platform: Record<string, number>;
  examples: Array<{
    category: "stable_direct" | "signed_valid" | "signed_expired" | "expired_without_recoverable_source";
    source_site?: string;
    host?: string;
    masked_url: string;
    expires_at?: string;
  }>;
}

/**
 * Sanitizes URLs by masking sensitive token / signature query parameters.
 * Ensures complete tokens are never exposed in reports, logs or CLI output.
 */
export function maskUrlTokens(rawUrl: string): string {
  if (!rawUrl) return "";
  try {
    const parsed = new URL(rawUrl);
    const sensitiveParams = [
      "token",
      "jwt",
      "access_token",
      "authorization",
      "s",
      "e",
      "exp",
      "expires",
      "expiry",
      "h",
      "hdnts",
      "st",
      "sig",
      "signature",
      "key",
      "auth",
      "hash",
    ];

    for (const key of Array.from(parsed.searchParams.keys())) {
      const lowerKey = key.toLowerCase();
      if (sensitiveParams.includes(lowerKey) || /token|key|sig|auth|jwt|hash/i.test(lowerKey)) {
        const val = parsed.searchParams.get(key) || "";
        const masked = val.length > 8 ? `${val.slice(0, 4)}...[REDACTED]` : "[REDACTED]";
        parsed.searchParams.set(key, masked);
      }
    }
    return decodeURIComponent(parsed.toString());
  } catch {
    return rawUrl.replace(
      /([?&](?:token|jwt|access_token|sig|signature|auth|s|e|exp|expires)=)[^&]+/gi,
      "$1[REDACTED]"
    );
  }
}

/**
 * Extracts the hostname safely from a URL string.
 */
export function extractHost(rawUrl: string): string {
  if (!rawUrl) return "unknown";
  try {
    return new URL(rawUrl).hostname || "unknown";
  } catch {
    return "invalid_url";
  }
}

/**
 * Classifies a URL into stream categories:
 * - "signed_valid": signed URL with expiration timestamp in the future.
 * - "signed_expired": signed URL with expiration timestamp in the past.
 * - "stable_direct": direct stream URL without temporary/signed expiration.
 * - "embed_or_page": web page or iframe embed URL.
 * - "other": unclassified URL.
 */
export function classifyStreamUrl(
  rawUrl: string,
  linkType?: string,
  now = Date.now()
): {
  category: "signed_valid" | "signed_expired" | "stable_direct" | "embed_or_page" | "other";
  expiresAt?: number;
  host: string;
} {
  const host = extractHost(rawUrl);
  if (!rawUrl) {
    return { category: "other", host };
  }

  const { expiresAt } = parseStreamExpiry(rawUrl);
  const hasExpiryParam = /([?&](?:s|e|exp|expires|expiry|token|jwt|h|hdnts|sig)=)/i.test(rawUrl);

  if (expiresAt !== undefined) {
    if (expiresAt > now) {
      return { category: "signed_valid", expiresAt, host };
    } else {
      return { category: "signed_expired", expiresAt, host };
    }
  }

  if (hasExpiryParam) {
    return { category: "signed_expired", expiresAt: undefined, host };
  }

  if (linkType === "embed" || /embed|iframe|player/i.test(rawUrl)) {
    return { category: "embed_or_page", host };
  }

  if (linkType === "direct" || /\.(m3u8|mp4|mkv|webm|ts)(\?.*)?$/i.test(rawUrl)) {
    return { category: "stable_direct", host };
  }

  return { category: "other", host };
}

/**
 * Runs a read-only, memory-safe paginated audit over stream sources in the database.
 */
export async function auditStreamSources(
  options: AuditStreamSourcesOptions = {}
): Promise<StreamSourceAuditReport> {
  const batchSize = Math.max(1, Math.min(1000, options.batchSize ?? 500));
  const limit = options.limit;
  const now = options.now ?? Date.now();
  const prisma = options.prismaClient ?? new PrismaClient();
  const shouldDisconnect = !options.prismaClient;

  const report: StreamSourceAuditReport = {
    timestamp: new Date(now).toISOString(),
    summary: {
      total_legacy_episodes: 0,
      total_source_links: 0,
      stable_direct: 0,
      signed_valid: 0,
      signed_expired: 0,
      expired_with_canonical_sister: 0,
      expired_without_recoverable_source: 0,
    },
    breakdown_by_host: {},
    breakdown_by_platform: {},
    examples: [],
  };

  const addExample = (
    category: StreamSourceAuditReport["examples"][number]["category"],
    rawUrl: string,
    source_site?: string,
    host?: string,
    expiresAt?: number
  ) => {
    if (report.examples.length < 20) {
      report.examples.push({
        category,
        source_site: source_site || "legacy",
        host: host || extractHost(rawUrl),
        masked_url: maskUrlTokens(rawUrl),
        expires_at: expiresAt ? new Date(expiresAt).toISOString() : undefined,
      });
    }
  };

  try {
    // 1. Audit legacy Episode table in pages
    let lastEpisodeId: string | undefined = undefined;
    let auditedEpisodes = 0;

    while (true) {
      const takeCount = limit ? Math.min(batchSize, limit - auditedEpisodes) : batchSize;
      if (takeCount <= 0) break;

      const episodes = await prisma.episode.findMany({
        take: takeCount,
        skip: lastEpisodeId ? 1 : 0,
        cursor: lastEpisodeId ? { id: lastEpisodeId } : undefined,
        orderBy: { id: "asc" },
        select: {
          id: true,
          source_url: true,
        },
      });

      if (episodes.length === 0) break;

      for (const ep of episodes) {
        report.summary.total_legacy_episodes++;
        auditedEpisodes++;

        if (ep.source_url) {
          const classification = classifyStreamUrl(ep.source_url, "direct", now);
          const host = classification.host;
          report.breakdown_by_host[host] = (report.breakdown_by_host[host] || 0) + 1;
          report.breakdown_by_platform["legacy_episode"] =
            (report.breakdown_by_platform["legacy_episode"] || 0) + 1;

          if (classification.category === "signed_valid") {
            report.summary.signed_valid++;
            addExample("signed_valid", ep.source_url, "legacy_episode", host, classification.expiresAt);
          } else if (classification.category === "signed_expired") {
            report.summary.signed_expired++;
            report.summary.expired_without_recoverable_source++;
            addExample("signed_expired", ep.source_url, "legacy_episode", host, classification.expiresAt);
          } else if (classification.category === "stable_direct") {
            report.summary.stable_direct++;
            addExample("stable_direct", ep.source_url, "legacy_episode", host);
          }
        }
      }

      lastEpisodeId = episodes[episodes.length - 1].id;
      if (limit && auditedEpisodes >= limit) break;
    }

    // 2. Audit MediaEpisode and SourceLink multi-source table in pages
    let lastMediaEpisodeId: string | undefined = undefined;
    let auditedMediaEpisodes = 0;

    while (true) {
      const takeCount = limit ? Math.min(batchSize, limit - auditedMediaEpisodes) : batchSize;
      if (takeCount <= 0) break;

      const mediaEpisodes = await prisma.mediaEpisode.findMany({
        take: takeCount,
        skip: lastMediaEpisodeId ? 1 : 0,
        cursor: lastMediaEpisodeId ? { id: lastMediaEpisodeId } : undefined,
        orderBy: { id: "asc" },
        select: {
          id: true,
          links: {
            select: {
              id: true,
              url: true,
              source_site: true,
              link_type: true,
              host: true,
            },
          },
        },
      });

      if (mediaEpisodes.length === 0) break;

      for (const me of mediaEpisodes) {
        auditedMediaEpisodes++;
        const links = me.links || [];
        report.summary.total_source_links += links.length;

        let hasExpiredLink = false;
        let hasCanonicalSister = false;
        let expiredSampleUrl: string | undefined = undefined;
        let expiredSampleHost: string | undefined = undefined;
        let expiredSampleExpiresAt: number | undefined = undefined;

        for (const link of links) {
          const platform = link.source_site || "unknown";
          report.breakdown_by_platform[platform] = (report.breakdown_by_platform[platform] || 0) + 1;

          const classification = classifyStreamUrl(link.url, link.link_type, now);
          const host = link.host || classification.host;
          report.breakdown_by_host[host] = (report.breakdown_by_host[host] || 0) + 1;

          if (classification.category === "signed_valid") {
            report.summary.signed_valid++;
            addExample("signed_valid", link.url, platform, host, classification.expiresAt);
          } else if (classification.category === "signed_expired") {
            report.summary.signed_expired++;
            hasExpiredLink = true;
            expiredSampleUrl = link.url;
            expiredSampleHost = host;
            expiredSampleExpiresAt = classification.expiresAt;
          } else if (classification.category === "stable_direct") {
            report.summary.stable_direct++;
            hasCanonicalSister = true;
            addExample("stable_direct", link.url, platform, host);
          } else if (classification.category === "embed_or_page") {
            hasCanonicalSister = true;
          }
        }

        if (hasExpiredLink) {
          if (hasCanonicalSister) {
            report.summary.expired_with_canonical_sister++;
          } else {
            report.summary.expired_without_recoverable_source++;
            if (expiredSampleUrl) {
              addExample(
                "expired_without_recoverable_source",
                expiredSampleUrl,
                "multi_source",
                expiredSampleHost,
                expiredSampleExpiresAt
              );
            }
          }
        }
      }

      lastMediaEpisodeId = mediaEpisodes[mediaEpisodes.length - 1].id;
      if (limit && auditedMediaEpisodes >= limit) break;
    }
  } finally {
    if (shouldDisconnect) {
      await prisma.$disconnect();
    }
  }

  if (options.reportPath) {
    const fullPath = path.resolve(options.reportPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, JSON.stringify(report, null, 2), "utf8");
  }

  return report;
}

/**
 * CLI Entrypoint
 */
export async function runCli() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Uso: npx tsx tools/audit_stream_sources.ts [opciones]

Auditoría de solo lectura sobre fuentes y episodios legacy/multi-source.
No realiza escrituras en base de datos. Consume memoria acotada (< 150MB).

Opciones:
  --batch-size <n>   Tamaño del lote paginado (default: 500, máx: 1000)
  --limit <n>        Límite máximo de registros a auditar (para pruebas rápidas)
  --report <ruta>    Ruta para guardar el reporte en formato JSON
  --json             Imprime únicamente el resultado JSON en stdout
  --help, -h         Muestra este mensaje de ayuda
`);
    process.exit(0);
  }

  let batchSize = 500;
  let limit: number | undefined = undefined;
  let reportPath: string | undefined = undefined;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--batch-size" && i + 1 < args.length) {
      batchSize = parseInt(args[++i], 10) || 500;
    } else if (arg === "--limit" && i + 1 < args.length) {
      limit = parseInt(args[++i], 10) || undefined;
    } else if (arg === "--report" && i + 1 < args.length) {
      reportPath = args[++i];
    } else if (arg === "--json") {
      jsonOutput = true;
    }
  }

  try {
    if (!jsonOutput) {
      console.log("Iniciando auditoría de fuentes (modo solo lectura)...");
    }

    const report = await auditStreamSources({
      batchSize,
      limit,
      reportPath,
      jsonOutput,
    });

    if (jsonOutput) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log("\n=================== RESUMEN DE AUDITORÍA ===================");
      console.log(`Fecha / Hora:                        ${report.timestamp}`);
      console.log(`Total episodios legacy:              ${report.summary.total_legacy_episodes}`);
      console.log(`Total SourceLinks:                   ${report.summary.total_source_links}`);
      console.log(`Directos estables:                   ${report.summary.stable_direct}`);
      console.log(`Firmados vigentes:                   ${report.summary.signed_valid}`);
      console.log(`Firmados vencidos:                   ${report.summary.signed_expired}`);
      console.log(`Vencidos con fuente hermana:         ${report.summary.expired_with_canonical_sister}`);
      console.log(`Vencidos sin fuente recuperable:     ${report.summary.expired_without_recoverable_source}`);
      console.log("\n--- Top Hosts ---");
      const topHosts = Object.entries(report.breakdown_by_host)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
      for (const [h, count] of topHosts) {
        console.log(`  ${h.padEnd(35)} : ${count}`);
      }

      console.log("\n--- Desglose por Plataforma ---");
      for (const [p, count] of Object.entries(report.breakdown_by_platform)) {
        console.log(`  ${p.padEnd(35)} : ${count}`);
      }

      console.log("\n--- Muestra de ejemplos (tokens anonimizados, máx 20) ---");
      for (const ex of report.examples) {
        console.log(`  [${ex.category}] ${ex.host} -> ${ex.masked_url.slice(0, 100)}`);
      }
      console.log("============================================================\n");

      if (reportPath) {
        console.log(`Reporte guardado en: ${reportPath}`);
      }
    }
  } catch (error: any) {
    console.error("Error durante la auditoría:", error?.message || error);
    process.exit(1);
  }
}

// Execute CLI only when this file is the direct entrypoint
const isMain = () => {
  if (!process.argv) return false;
  return process.argv.some(
    (arg) =>
      arg.endsWith("audit_stream_sources.ts") ||
      arg.endsWith("audit_stream_sources.js")
  );
};

if (!process.env.VITEST && isMain()) {
  runCli();
}
