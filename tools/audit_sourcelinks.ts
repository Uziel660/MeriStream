// tools/audit_sourcelinks.ts
import { PrismaClient } from "@prisma/client";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseStreamExpiry } from "../server/resolutionMetadata";

export type SourceLinkCategory =
  | "canonical_page"
  | "canonical_embed"
  | "stable_direct"
  | "active_ephemeral_direct"
  | "expired_ephemeral_direct"
  | "invalid_catalog_page"
  | "unknown";

export interface ClassificationResult {
  category: SourceLinkCategory;
  reason: string;
  host: string;
  isExpired: boolean;
  expiresAt?: number;
  isCatalogPage: boolean;
}

export interface ProviderAuditSummary {
  provider: string;
  total_links: number;
  by_category: Record<SourceLinkCategory, number>;
  invalid_catalog_urls_count: number;
  expired_ephemeral_direct_count: number;
  sources_requiring_canonical_reconstruction: number;
  episodes_with_sister_canonical_page: number;
  episodes_with_sister_embed: number;
  episodes_without_any_valid_source: number;
}

export interface SourceLinkAuditReport {
  timestamp: string;
  target_sites: string[];
  summary: {
    total_links_audited: number;
    total_episodes_audited: number;
    categories: Record<SourceLinkCategory, number>;
    total_requiring_canonical_reconstruction: number;
  };
  providers: Record<string, ProviderAuditSummary>;
  action_plan: ActionPlanItem[];
  sanitized_samples: Array<{
    provider: string;
    category: SourceLinkCategory;
    sanitized_url: string;
    host: string;
    expires_at_iso?: string;
  }>;
}

export interface ActionPlanItem {
  id: string;
  provider: string;
  severity: "high" | "medium" | "low";
  action: string;
  rationale: string;
  affected_count: number;
  execution_safety: "safe_automated_plan" | "manual_approval_required";
  steps: string[];
}

export interface AuditSourceLinksOptions {
  sites?: string[];
  batchSize?: number;
  limit?: number;
  reportJsonPath?: string;
  reportMdPath?: string;
  prismaClient?: PrismaClient;
  now?: number;
}

/**
 * Sanitiza una URL eliminando completamente tokens, firmas y query strings sensibles.
 * Mantiene solo protocolo, host y path limpio para evitar cualquier fuga de credenciales.
 */
export function sanitizeUrlForReport(rawUrl: string): string {
  if (!rawUrl) return "";
  try {
    const parsed = new URL(rawUrl);
    if (parsed.search) {
      return `${parsed.protocol}//${parsed.host}${parsed.pathname}?[QUERY_STRIPPED]`;
    }
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return rawUrl.split("?")[0];
  }
}

/**
 * Extrae el host de una URL de forma segura.
 */
export function extractSafeHost(rawUrl: string): string {
  if (!rawUrl) return "unknown";
  try {
    return new URL(rawUrl).hostname || "unknown";
  } catch {
    return "invalid_url";
  }
}

/**
 * Detecta si una URL corresponde a una página de catálogo / listado / paginación
 * guardada erróneamente como enlace de episodio o película (ej. /page/1/, /page/2/, etc.).
 */
export function detectCatalogPageUrl(rawUrl: string): boolean {
  if (!rawUrl) return false;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const pathname = parsed.pathname.toLowerCase();

    // Patrones de paginación o listados de catálogo (/page/1/, /page/42/, etc.)
    if (/\/page\/\d+/i.test(pathname)) return true;

    // Parámetros de paginación comunes en catálogos
    if (parsed.searchParams.has("page") || parsed.searchParams.has("paged")) {
      const pageVal = parsed.searchParams.get("page") || parsed.searchParams.get("paged");
      if (pageVal && /^\d+$/.test(pageVal)) return true;
    }

    const host = parsed.hostname.toLowerCase();
    const isTargetCatalogHost =
      host.includes("cinecalidad.") ||
      host.includes("lamovie.") ||
      host.includes("tioplus.");

    if (isTargetCatalogHost) {
      if (/(^|\/)(catalogo|peliculas|series|estrenos|genero|category|categoria)\/?$/i.test(pathname)) return true;
      if (pathname === "/" || pathname === "") return true;
    }

    return false;
  } catch {
    return /\/page\/\d+/i.test(rawUrl);
  }
}

/**
 * Detecta si una URL HLS/MP4 está firmada y si ha expirado.
 * Soporta de manera nativa firmas s=<epoch>&e=<ttl>, exp=<epoch>, expires=<epoch>, token=jwt, etc.
 */
export function checkUrlExpiry(
  rawUrl: string,
  now = Date.now()
): { isSigned: boolean; isExpired: boolean; expiresAt?: number } {
  if (!rawUrl) return { isSigned: false, isExpired: false };

  try {
    const parsed = new URL(rawUrl);

    // 1. Detección de firmas tipo s=<epoch>&e=<ttl> (usado en Vimeos, Acek-CDN, Dramiyos-CDN, Goodstream)
    const sParam = parsed.searchParams.get("s");
    const eParam = parsed.searchParams.get("e");
    if (sParam && eParam) {
      const sNum = Number(sParam);
      const eNum = Number(eParam);
      if (Number.isFinite(sNum) && Number.isFinite(eNum) && sNum > 0 && eNum > 0) {
        // En este patrón, s es el epoch start (en segundos) y e es la duración o TTL (en segundos)
        // La expiración es (s + e) * 1000 ms
        const expiresAt = (sNum + eNum) * 1000;
        return {
          isSigned: true,
          isExpired: expiresAt <= now,
          expiresAt,
        };
      }
    }

    // 2. Uso del parser centralizado de expiración del servidor para JWTs y parámetros estándar (exp, expires, etc.)
    const { expiresAt } = parseStreamExpiry(rawUrl);
    if (expiresAt !== undefined) {
      return {
        isSigned: true,
        isExpired: expiresAt <= now,
        expiresAt,
      };
    }

    // 3. Verificación de presencia de parámetros de seguridad o tokens conocidos
    const hasSignatureParam = [
      "token",
      "jwt",
      "access_token",
      "sig",
      "signature",
      "auth",
      "key",
      "h",
      "hdnts",
      "st",
      "hash",
      "exp",
      "expires",
      "expiry",
    ].some((p) => parsed.searchParams.has(p));

    // 4. Dominios CDN conocidos por emitir exclusivamente URLs efímeras con firma temporal
    const hostname = parsed.hostname.toLowerCase();
    const isEphemeralCdn =
      hostname.endsWith("acek-cdn.com") ||
      hostname.endsWith("dramiyos-cdn.com") ||
      hostname.includes("vimeos.") ||
      hostname.endsWith("goodstream.one");

    if (hasSignatureParam || (isEphemeralCdn && parsed.search.length > 0)) {
      return {
        isSigned: true,
        // La presencia de una firma no demuestra que el enlace esté vencido.
        // Si no existe una fecha explícita, se clasifica como efímero activo
        // (expiración desconocida) y nunca se purga automáticamente.
        isExpired: false,
      };
    }

    return { isSigned: false, isExpired: false };
  } catch {
    return { isSigned: false, isExpired: false };
  }
}

/**
 * Clasifica un SourceLink en una de las 7 categorías requeridas:
 * 1. canonical_page
 * 2. canonical_embed
 * 3. stable_direct
 * 4. active_ephemeral_direct
 * 5. expired_ephemeral_direct
 * 6. invalid_catalog_page
 * 7. unknown
 */
export function classifySourceLink(
  rawUrl: string,
  linkType?: string,
  sourceSite?: string,
  now = Date.now()
): ClassificationResult {
  const host = extractSafeHost(rawUrl);

  if (!rawUrl || host === "unknown" || host === "invalid_url") {
    return {
      category: "unknown",
      reason: "URL vacía o formato inválido",
      host,
      isExpired: false,
      isCatalogPage: false,
    };
  }

  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        category: "unknown",
        reason: "Protocolo no soportado (distinto de http/https)",
        host,
        isExpired: false,
        isCatalogPage: false,
      };
    }
  } catch {
    return {
      category: "unknown",
      reason: "URL no parseable",
      host,
      isExpired: false,
      isCatalogPage: false,
    };
  }

  // 1. Detección prioritaria: URLs de catálogo/paginación guardadas como fuente
  if (detectCatalogPageUrl(rawUrl)) {
    return {
      category: "invalid_catalog_page",
      reason: "URL corresponde a paginación o listado de catálogo (/page/N/ o sección de índice)",
      host,
      isExpired: false,
      isCatalogPage: true,
    };
  }

  const { isSigned, isExpired, expiresAt } = checkUrlExpiry(rawUrl, now);
  const isDirectStream =
    linkType === "direct" ||
    /\.(m3u8|mp4|mkv|webm|ts)(\?.*)?$/i.test(rawUrl) ||
    rawUrl.includes(".urlset/");

  // 2. Clasificación de Streams Directos
  if (isDirectStream) {
    if (isSigned && isExpired) {
      return {
        category: "expired_ephemeral_direct",
        reason: "Stream HLS/MP4 firmado con firma temporal (s+e / token / exp) vencida",
        host,
        isExpired: true,
        expiresAt,
        isCatalogPage: false,
      };
    }

    if (!isSigned) {
      return {
        category: "stable_direct",
        reason: "Stream HLS/MP4 directo permanente sin parámetros de expiración ni firma",
        host,
        isExpired: false,
        isCatalogPage: false,
      };
    }

    // Stream firmado cuya expiración no es conocida o aún no ha vencido.
    // No debe contarse como roto: requiere validación JIT, no purga.
    return {
      category: "active_ephemeral_direct",
      reason: expiresAt
        ? "Stream HLS/MP4 firmado con expiración explícita aún vigente"
        : "Stream HLS/MP4 firmado con expiración no determinable; requiere validación JIT",
      host,
      isExpired: false,
      expiresAt,
      isCatalogPage: false,
    };
  }

  // 3. Clasificación de Embeds Canónicos
  const isEmbedHost =
    host.includes("voe.") ||
    host.includes("dood") ||
    host.includes("mega.nz") ||
    host.includes("videoapp.") ||
    host.includes("goodstream.") ||
    host.includes("vidhide") ||
    host.includes("turbovid") ||
    host.includes("streamwish") ||
    host.includes("uqload") ||
    host.includes("player");

  const isEmbedPath =
    /\/e\/|\/embed[-/]|\/player\//i.test(rawUrl) || linkType === "embed";

  // Verificamos si es un dominio canónico de proveedor (tioplus.app, lamovie.org, cinecalidad.am)
  const isProviderDomain =
    host.includes("tioplus.app") ||
    host.includes("lamovie.org") ||
    host.includes("cinecalidad.");

  if (isEmbedHost || (isEmbedPath && !isProviderDomain)) {
    return {
      category: "canonical_embed",
      reason: "Reproductor iframe/embed de terceros con ID de medio permanente",
      host,
      isExpired: false,
      isCatalogPage: false,
    };
  }

  // 4. Clasificación de Páginas Canónicas de Detalle
  if (isProviderDomain) {
    return {
      category: "canonical_page",
      reason: "Página web de detalle canónica en el portal del proveedor",
      host,
      isExpired: false,
      isCatalogPage: false,
    };
  }

  // Si no encaja en ninguna categoría clara
  return {
    category: "unknown",
    reason: "URL no identificable con los patrones canónicos conocidos",
    host,
    isExpired: false,
    isCatalogPage: false,
  };
}

/**
 * Ejecuta la auditoría completa de solo lectura sobre SourceLink para los sitios objetivo.
 */
export async function auditTargetSourceLinks(
  options: AuditSourceLinksOptions = {}
): Promise<SourceLinkAuditReport> {
  const targetSites = options.sites ?? ["tioplus.app", "lamovie.org", "cinecalidad.am"];
  const batchSize = Math.max(1, Math.min(1000, options.batchSize ?? 500));
  const limit = options.limit;
  const now = options.now ?? Date.now();
  const prisma = options.prismaClient ?? new PrismaClient();
  const shouldDisconnect = !options.prismaClient;

  const report: SourceLinkAuditReport = {
    timestamp: new Date(now).toISOString(),
    target_sites: targetSites,
    summary: {
      total_links_audited: 0,
      total_episodes_audited: 0,
      categories: {
        canonical_page: 0,
        canonical_embed: 0,
        stable_direct: 0,
        active_ephemeral_direct: 0,
        expired_ephemeral_direct: 0,
        invalid_catalog_page: 0,
        unknown: 0,
      },
      total_requiring_canonical_reconstruction: 0,
    },
    providers: {},
    action_plan: [],
    sanitized_samples: [],
  };

  // Inicializar contadores por proveedor
  for (const site of targetSites) {
    report.providers[site] = {
      provider: site,
      total_links: 0,
      by_category: {
        canonical_page: 0,
        canonical_embed: 0,
        stable_direct: 0,
        active_ephemeral_direct: 0,
        expired_ephemeral_direct: 0,
        invalid_catalog_page: 0,
        unknown: 0,
      },
      invalid_catalog_urls_count: 0,
      expired_ephemeral_direct_count: 0,
      sources_requiring_canonical_reconstruction: 0,
      episodes_with_sister_canonical_page: 0,
      episodes_with_sister_embed: 0,
      episodes_without_any_valid_source: 0,
    };
  }

  try {
    for (const site of targetSites) {
      const providerStats = report.providers[site];
      let lastLinkId: string | undefined = undefined;
      let auditedSiteLinks = 0;

      // Estructura para agrupar por episodio y determinar si tiene fuentes hermanas válidas
      const episodeMap = new Map<
        string,
        {
          hasCanonicalPage: boolean;
          hasCanonicalEmbed: boolean;
          hasStableDirect: boolean;
          hasBrokenOrExpired: boolean;
        }
      >();

      while (true) {
        const takeCount = limit ? Math.min(batchSize, limit - auditedSiteLinks) : batchSize;
        if (takeCount <= 0) break;

        const links = await prisma.sourceLink.findMany({
          where: { source_site: site },
          take: takeCount,
          skip: lastLinkId ? 1 : 0,
          cursor: lastLinkId ? { id: lastLinkId } : undefined,
          orderBy: { id: "asc" },
          select: {
            id: true,
            url: true,
            link_type: true,
            source_site: true,
            host: true,
            media_episode_id: true,
          },
        });

        if (links.length === 0) break;

        for (const link of links) {
          auditedSiteLinks++;
          report.summary.total_links_audited++;
          providerStats.total_links++;

          const classification = classifySourceLink(link.url, link.link_type, link.source_site, now);
          const cat = classification.category;

          report.summary.categories[cat]++;
          providerStats.by_category[cat]++;

          if (cat === "invalid_catalog_page") {
            providerStats.invalid_catalog_urls_count++;
          }
          if (cat === "expired_ephemeral_direct") {
            providerStats.expired_ephemeral_direct_count++;
          }

          // Registrar en mapa de episodios
          let epEntry = episodeMap.get(link.media_episode_id);
          if (!epEntry) {
            epEntry = {
              hasCanonicalPage: false,
              hasCanonicalEmbed: false,
              hasStableDirect: false,
              hasBrokenOrExpired: false,
            };
            episodeMap.set(link.media_episode_id, epEntry);
          }

          if (cat === "canonical_page") epEntry.hasCanonicalPage = true;
          else if (cat === "canonical_embed") epEntry.hasCanonicalEmbed = true;
          else if (cat === "stable_direct") epEntry.hasStableDirect = true;
          else if (cat === "expired_ephemeral_direct" || cat === "invalid_catalog_page") {
            epEntry.hasBrokenOrExpired = true;
          }

          // Guardar muestras sanitizadas (hasta 10 por proveedor)
          if (report.sanitized_samples.filter((s) => s.provider === site).length < 10) {
            report.sanitized_samples.push({
              provider: site,
              category: cat,
              sanitized_url: sanitizeUrlForReport(link.url),
              host: classification.host,
              expires_at_iso: classification.expiresAt
                ? new Date(classification.expiresAt).toISOString()
                : undefined,
            });
          }
        }

        lastLinkId = links[links.length - 1].id;
        if (limit && auditedSiteLinks >= limit) break;
      }

      // Analizar cobertura por episodio para este proveedor
      let siteRequiringReconstruction = 0;
      for (const [_, ep] of episodeMap.entries()) {
        report.summary.total_episodes_audited++;
        if (ep.hasBrokenOrExpired) {
          if (ep.hasCanonicalPage) {
            providerStats.episodes_with_sister_canonical_page++;
          } else if (ep.hasCanonicalEmbed) {
            providerStats.episodes_with_sister_embed++;
          } else if (!ep.hasStableDirect) {
            providerStats.episodes_without_any_valid_source++;
            siteRequiringReconstruction++;
          }
        } else if (!ep.hasCanonicalPage && !ep.hasCanonicalEmbed && !ep.hasStableDirect) {
          providerStats.episodes_without_any_valid_source++;
          siteRequiringReconstruction++;
        }
      }

      // Fuentes de este proveedor que deben ser reconstruidas desde una página canónica
      providerStats.sources_requiring_canonical_reconstruction =
        providerStats.expired_ephemeral_direct_count + providerStats.invalid_catalog_urls_count;

      report.summary.total_requiring_canonical_reconstruction +=
        providerStats.sources_requiring_canonical_reconstruction;
    }

    // Generar Plan de Acciones basado en hallazgos
    report.action_plan = buildActionPlan(report);

  } finally {
    if (shouldDisconnect) {
      await prisma.$disconnect();
    }
  }

  // Guardar reportes si se especificaron rutas
  if (options.reportJsonPath) {
    const fullPath = path.resolve(options.reportJsonPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, JSON.stringify(report, null, 2), "utf8");
  }

  if (options.reportMdPath) {
    const fullPath = path.resolve(options.reportMdPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    const mdContent = generateMarkdownReport(report);
    await fs.writeFile(fullPath, mdContent, "utf8");
  }

  return report;
}

/**
 * Genera el plan de acciones detallado sin ejecutar mutaciones.
 */
function buildActionPlan(report: SourceLinkAuditReport): ActionPlanItem[] {
  const plan: ActionPlanItem[] = [];

  const tioplus = report.providers["tioplus.app"];
  if (tioplus && tioplus.expired_ephemeral_direct_count > 0) {
    plan.push({
      id: "PLAN-TIOPLUS-01",
      provider: "tioplus.app",
      severity: "high",
      action: "Reconstruir catálogo canónico para episodios con HLS efímeros vencidos",
      rationale:
        "El 100% de los streams directos de tioplus.app corresponden a acek-cdn y dramiyos-cdn firmados con s+e ya vencidos. No existe ninguna URL de detalle en tioplus.app almacenada.",
      affected_count: tioplus.expired_ephemeral_direct_count,
      execution_safety: "manual_approval_required",
      steps: [
        "Identificar los MediaItems asociados a los episodios afectados.",
        "Ejecutar scraper canónico de tioplus.app para extraer la URL de página canónica (/pelicula/... o /serie/...) y/o embeds permanentes.",
        "Insertar las nuevas fuentes canónicas con source_kind='page' o 'embed'.",
        "Depurar de forma segura los SourceLinks expirados una vez verificada la nueva fuente canónica.",
      ],
    });
  }

  const cinecalidad = report.providers["cinecalidad.am"];
  if (cinecalidad && cinecalidad.invalid_catalog_urls_count > 0) {
    plan.push({
      id: "PLAN-CINECALIDAD-01",
      provider: "cinecalidad.am",
      severity: "high",
      action: "Eliminar / reclasificar URLs de catálogo /page/N/ asociadas erróneamente a episodios",
      rationale:
        "Se detectaron URLs de paginación (ej. https://www.cinecalidad.am/page/1/) guardadas como fuente de reproducción de episodios específicos.",
      affected_count: cinecalidad.invalid_catalog_urls_count,
      execution_safety: "manual_approval_required",
      steps: [
        "Aislar los registros de SourceLink que coincidan con regex /page/\\d+/.",
        "Comprobar si el episodio cuenta con una página canónica hermana (/ver-pelicula/...).",
        "Si cuenta con hermana, marcar la URL de catálogo para remoción segura en una migración planificada.",
        "Actualizar el scraper de cinecalidad para evitar que la URL de navegación sea persistida como stream del ítem.",
      ],
    });
  }

  if (cinecalidad && cinecalidad.expired_ephemeral_direct_count > 0) {
    plan.push({
      id: "PLAN-CINECALIDAD-02",
      provider: "cinecalidad.am",
      severity: "medium",
      action: "Remover enlaces directos temporales (Vimeos/Goodstream s+e) que ya cuentan con página canónica",
      rationale:
        "Cinecalidad almacena la página canónica (/ver-pelicula/...) junto a links directos firmados vencidos. Los links directos son redundantes y fallan de inmediato.",
      affected_count: cinecalidad.expired_ephemeral_direct_count,
      execution_safety: "manual_approval_required",
      steps: [
        "Verificar que cada episodio con link Vimeos/Goodstream s+e tenga su página canónica hermana.",
        "Validar resolución JIT a demanda desde la página canónica.",
        "Purgar los registros de SourceLink directos expirados mediante migración controlada.",
      ],
    });
  }

  const lamovie = report.providers["lamovie.org"];
  if (lamovie && lamovie.expired_ephemeral_direct_count > 0) {
    plan.push({
      id: "PLAN-LAMOVIE-01",
      provider: "lamovie.org",
      severity: "medium",
      action: "Limpiar streams directos efímeros que cuentan con página canónica hermana",
      rationale:
        "Existen enlaces directos temporales a vimeos y goodstream que ya han expirado pero cuentan con su página canónica de lamovie.org/peliculas/.",
      affected_count: lamovie.expired_ephemeral_direct_count,
      execution_safety: "manual_approval_required",
      steps: [
        "Asegurar que la resolución JIT esté operativa para páginas canónicas de lamovie.org.",
        "Descartar los SourceLinks de tipo direct firmados vencidos.",
      ],
    });
  }

  return plan;
}

/**
 * Genera el reporte formateado en Markdown para humanos y documentación técnica,
 * garantizando que ninguna URL contenga tokens ni firmas completas.
 */
export function generateMarkdownReport(report: SourceLinkAuditReport): string {
  const lines: string[] = [];

  lines.push("# Reporte de Auditoría de SourceLinks — Meristream");
  lines.push("");
  lines.push(`**Fecha de ejecución:** \`${report.timestamp}\`  `);
  lines.push(`**Proveedores auditados:** ${report.target_sites.map((s) => `\`${s}\``).join(", ")}  `);
  lines.push(`**Total enlaces auditados:** \`${report.summary.total_links_audited}\`  `);
  lines.push(`**Total fuentes a reconstruir:** \`${report.summary.total_requiring_canonical_reconstruction}\`  `);
  lines.push("");
  lines.push("> [!NOTE]");
  lines.push("> Este reporte fue generado en modo estrictamente de solo lectura. No se ha modificado la base de datos.");
  lines.push("> Todas las URLs han sido sanitizadas: se han eliminado todos los tokens, firmas y query strings sensibles.");
  lines.push("");
  lines.push("## Resumen General por Categoría");
  lines.push("");
  lines.push("| Categoría | Total Enlaces | Descripción |");
  lines.push("| :--- | :--- | :--- |");
  lines.push(`| \`canonical_page\` | ${report.summary.categories.canonical_page} | Páginas de detalle oficiales del portal del proveedor |`);
  lines.push(`| \`canonical_embed\` | ${report.summary.categories.canonical_embed} | Embeds externos con ID permanente (Voe, Mega, Dood, etc.) |`);
  lines.push(`| \`stable_direct\` | ${report.summary.categories.stable_direct} | Streams directos HLS/MP4 permanentes sin expiración |`);
  lines.push(`| \`active_ephemeral_direct\` | ${report.summary.categories.active_ephemeral_direct} | Streams HLS/MP4 firmados aún vigentes o con expiración no determinable (validar JIT) |`);
  lines.push(`| \`expired_ephemeral_direct\` | ${report.summary.categories.expired_ephemeral_direct} | Streams HLS/MP4 firmados con firma temporal vencida |`);
  lines.push(`| \`invalid_catalog_page\` | ${report.summary.categories.invalid_catalog_page} | URLs de catálogo o paginación (/page/N/) guardadas como fuente |`);
  lines.push(`| \`unknown\` | ${report.summary.categories.unknown} | URLs no reconocidas o malformadas |`);
  lines.push("");
  lines.push("## Desglose por Proveedor");
  lines.push("");

  for (const [site, p] of Object.entries(report.providers)) {
    lines.push(`### Proveedor: \`${site}\``);
    lines.push("");
    lines.push(`- **Total enlaces:** ${p.total_links}`);
    lines.push(`- **Páginas canónicas (\`canonical_page\`):** ${p.by_category.canonical_page}`);
    lines.push(`- **Embeds canónicos (\`canonical_embed\`):** ${p.by_category.canonical_embed}`);
    lines.push(`- **Directos estables (\`stable_direct\`):** ${p.by_category.stable_direct}`);
    lines.push(`- **Directos efímeros activos/no determinables (\`active_ephemeral_direct\`):** ${p.by_category.active_ephemeral_direct}`);
    lines.push(`- **Directos efímeros vencidos (\`expired_ephemeral_direct\`):** ${p.expired_ephemeral_direct_count}`);
    lines.push(`- **URLs inválidas de catálogo (\`invalid_catalog_page\`):** ${p.invalid_catalog_urls_count}`);
    lines.push(`- **Fuentes que deben reconstruirse desde página canónica:** **${p.sources_requiring_canonical_reconstruction}**`);
    lines.push(`- **Episodios con hermana canónica viva:** ${p.episodes_with_sister_canonical_page}`);
    lines.push(`- **Episodios sin ninguna fuente válida restante:** ${p.episodes_without_any_valid_source}`);
    lines.push("");
  }

  lines.push("## Plan de Acciones Propuesto (Sin Ejecución de Modificaciones)");
  lines.push("");
  lines.push("A continuación se detallan las acciones de remediación recomendadas:");
  lines.push("");

  for (const item of report.action_plan) {
    lines.push(`### [${item.id}] ${item.action}`);
    lines.push(`- **Proveedor:** \`${item.provider}\``);
    lines.push(`- **Severidad:** \`${item.severity.toUpperCase()}\``);
    lines.push(`- **Registros afectados:** \`${item.affected_count}\``);
    lines.push(`- **Justificación:** ${item.rationale}`);
    lines.push("- **Pasos planificados:**");
    for (const step of item.steps) {
      lines.push(`  1. ${step}`);
    }
    lines.push("");
  }

  lines.push("## Muestra de Enlaces Sanitizados (Máximo 10 por proveedor)");
  lines.push("");
  lines.push("| Proveedor | Categoría | Host | URL Sanitizada (Sin Tokens / Query Strings) |");
  lines.push("| :--- | :--- | :--- | :--- |");
  for (const sample of report.sanitized_samples) {
    lines.push(`| \`${sample.provider}\` | \`${sample.category}\` | \`${sample.host}\` | \`${sample.sanitized_url}\` |`);
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * Entrada CLI
 */
export async function runCli() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
Uso: npx tsx tools/audit_sourcelinks.ts [opciones]

Auditoría de solo lectura sobre SourceLink para tioplus.app, lamovie.org y cinecalidad.am.
Detecta firmas s=<epoch>&e=<ttl>, clasifica en 7 categorías, detecta páginas de catálogo,
sanitiza tokens y query strings, y genera un plan de acciones sin realizar modificaciones.

Opciones:
  --sites <sitios>       Lista separada por comas (default: tioplus.app,lamovie.org,cinecalidad.am)
  --batch-size <n>       Tamaño del lote paginado (default: 500, máx: 1000)
  --limit <n>            Límite de registros por sitio a auditar (para pruebas rápidas)
  --report-json <ruta>   Ruta para guardar el reporte JSON sanitizado
  --report-md <ruta>     Ruta para guardar el reporte Markdown sanitizado
  --json                 Imprime únicamente el reporte JSON en stdout
  --help, -h             Muestra esta ayuda
`);
    process.exit(0);
  }

  let sites = ["tioplus.app", "lamovie.org", "cinecalidad.am"];
  let batchSize = 500;
  let limit: number | undefined = undefined;
  let reportJsonPath: string | undefined = undefined;
  let reportMdPath: string | undefined = undefined;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--sites" && i + 1 < args.length) {
      sites = args[++i].split(",").map((s) => s.trim());
    } else if (arg === "--batch-size" && i + 1 < args.length) {
      batchSize = parseInt(args[++i], 10) || 500;
    } else if (arg === "--limit" && i + 1 < args.length) {
      limit = parseInt(args[++i], 10) || undefined;
    } else if (arg === "--report-json" && i + 1 < args.length) {
      reportJsonPath = args[++i];
    } else if (arg === "--report-md" && i + 1 < args.length) {
      reportMdPath = args[++i];
    } else if (arg === "--json") {
      jsonOutput = true;
    }
  }

  try {
    if (!jsonOutput) {
      console.log("Iniciando auditoría especializada de SourceLinks (modo solo lectura)...");
    }

    const report = await auditTargetSourceLinks({
      sites,
      batchSize,
      limit,
      reportJsonPath,
      reportMdPath,
    });

    if (jsonOutput) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log("\n=================== AUDITORÍA DE SOURCELINKS ===================");
      console.log(`Fecha / Hora:                        ${report.timestamp}`);
      console.log(`Total enlaces auditados:             ${report.summary.total_links_audited}`);
      console.log(`Total fuentes a reconstruir:         ${report.summary.total_requiring_canonical_reconstruction}`);
      console.log("\n--- Resumen por Categoría ---");
      for (const [cat, count] of Object.entries(report.summary.categories)) {
        console.log(`  ${cat.padEnd(28)} : ${count}`);
      }

      console.log("\n--- Resumen por Proveedor ---");
      for (const [provider, p] of Object.entries(report.providers)) {
        console.log(`\n  [${provider}]`);
        console.log(`    Total enlaces:                   ${p.total_links}`);
        console.log(`    Páginas canónicas:               ${p.by_category.canonical_page}`);
        console.log(`    Embeds canónicos:                ${p.by_category.canonical_embed}`);
        console.log(`    Directos estables:               ${p.by_category.stable_direct}`);
        console.log(`    Directos efímeros activos/JIT:   ${p.by_category.active_ephemeral_direct}`);
        console.log(`    Directos efímeros vencidos:      ${p.expired_ephemeral_direct_count}`);
        console.log(`    Catálogo inválido (/page/N/):    ${p.invalid_catalog_urls_count}`);
        console.log(`    Fuentes a reconstruir canónica:  ${p.sources_requiring_canonical_reconstruction}`);
      }

      console.log("\n--- Plan de Acciones Propuesto (Sin escrituras) ---");
      for (const item of report.action_plan) {
        console.log(`  * [${item.id}] (${item.provider}) ${item.action}`);
        console.log(`    Afectados: ${item.affected_count} | Severidad: ${item.severity}`);
      }

      console.log("================================================================\n");

      if (reportJsonPath) console.log(`Reporte JSON guardado en: ${reportJsonPath}`);
      if (reportMdPath) console.log(`Reporte Markdown guardado en: ${reportMdPath}`);
    }
  } catch (error: any) {
    console.error("Error durante la auditoría:", error?.message || error);
    process.exit(1);
  }
}

// Ejecución directa si se invoca desde CLI
const isDirectCli = () => {
  if (!process.argv) return false;
  return process.argv.some(
    (arg) =>
      arg.endsWith("audit_sourcelinks.ts") ||
      arg.endsWith("audit_sourcelinks.js")
  );
};

if (!process.env.VITEST && isDirectCli()) {
  runCli();
}
