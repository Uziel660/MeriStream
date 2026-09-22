import { BaseScraperAdapter, COMMON_HEADERS } from "../BaseAdapter";
import { UniversalAnalysisResult } from "../../types";
import { cleanQueryTitle } from "../../metadataEngine";

/**
 * Extrae el primer año plausible (1900..actual+1) de un texto libre
 * (description/title del ítem; Archive.org puede devolver arrays).
 * Devuelve null si no hay ninguno creíble: defecto #24 — nunca inventar
 * un año hardcodeado.
 */
export function extractYearFromText(text?: string | string[] | null): number | null {
  if (!text) return null;
  const flat = Array.isArray(text) ? text.join(" ") : text;
  const matches = flat.match(/\b(19\d{2}|20[0-2]\d)\b/g);
  if (!matches) return null;
  const maxValid = new Date().getFullYear() + 1;
  for (const m of matches) {
    const year = parseInt(m, 10);
    if (year >= 1900 && year <= maxValid) return year;
  }
  return null;
}

/** Host CORS de Archive.org que entrega `Access-Control-Allow-Origin: *` para <video crossorigin="anonymous"> */
const CORS_BASE = "https://cors.archive.org/cors";

/**
 * Construye URL CORS para un archivo de Archive.org.
 * Codifica cada segmento para preservar '/' (p.ej. archivos en subcarpeta).
 */
function buildCorsUrl(identifier: string, name: string): string {
  const encoded = name.split("/").map(encodeURIComponent).join("/");
  return `${CORS_BASE}/${identifier}/${encoded}`;
}

/** Prioridad por extensión: mp4 (más compatible nativo) < m3u8 < webm < mkv */
function extPriority(name: string): number {
  const lower = name.toLowerCase();
  if (lower.endsWith(".mp4")) return 0;
  if (lower.endsWith(".m3u8")) return 1;
  if (lower.endsWith(".webm")) return 2;
  if (lower.endsWith(".mkv")) return 3;
  return 4;
}

/** Score por formato: menor = más preferido (h.264/AVC > MPEG4/512kb > genérico) */
function formatScore(format?: string): number {
  const f = (format || "").toLowerCase();
  if (f.includes("h.264") || f.includes("h264") || f.includes("avc")) return 0;
  if (f.includes("mpeg4") || f.includes("512kb") || f.includes("512 kb")) return 1;
  if (f.includes("webm")) return 2;
  if (f.includes("matroska") || f.includes("mkv")) return 3;
  // si no hay tag pero es video mp4, considerarlo intermedio
  if (f.includes("mpeg") || f.includes("mp4")) return 1;
  return 4;
}

function sourcePriority(source?: string): number {
  const s = (source || "").toLowerCase();
  if (s === "derivative") return 0;
  if (s === "original") return 1;
  return 2;
}

export class ArchiveOrgAdapter extends BaseScraperAdapter {
  readonly id = "archive_org";
  readonly name = "Internet Archive (Archive.org)";
  readonly supportedDomains = ["archive.org"];

  canHandle(url: string): boolean {
    return url.toLowerCase().includes("archive.org/details/");
  }

  /**
   * Defecto #23: valida por HEAD que una URL inventada realmente exista antes de
   * guardarla como fuente. Los ítems oscurecidos/borrados devuelven 403/404.
   */
  private async headExists(url: string): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(url, {
        method: "HEAD",
        redirect: "follow",
        signal: controller.signal,
        headers: COMMON_HEADERS,
      });
      clearTimeout(timer);
      return res.ok || res.status === 206;
    } catch {
      return false;
    }
  }

  async analyze(input: string): Promise<UniversalAnalysisResult> {
    const archiveUrl = input.trim();
    const match = archiveUrl.match(/archive\.org\/details\/([^/?#]+)/);
    const identifier = match ? match[1] : "";

    let title = identifier.replace(/[-_]/g, " ");
    let desc = "Película o archivo de libre distribución en Internet Archive.";
    let itemYear: number | null = null;
    const poster = identifier ? `https://archive.org/services/img/${identifier}` : null;
    const detectedStreams: string[] = [];

    if (identifier) {
      try {
        const metaRes = await fetch(`https://archive.org/metadata/${identifier}`, { headers: COMMON_HEADERS });
        if (metaRes.ok) {
          const metaData: any = await metaRes.json();
          if (metaData.metadata) {
            title = metaData.metadata.title || title;
            desc =
              typeof metaData.metadata.description === "string"
                ? metaData.metadata.description
                : Array.isArray(metaData.metadata.description)
                  ? metaData.metadata.description.join(" ")
                  : desc;

            // Defecto #24: año real del ítem (metadata.year puede ser string/array)
            const rawYear = metaData.metadata.year ?? metaData.metadata.date;
            if (Array.isArray(rawYear)) {
              itemYear = extractYearFromText(rawYear.join(" "));
            } else if (typeof rawYear === "string" && /^\d{4}/.test(rawYear.trim())) {
              itemYear = parseInt(rawYear.trim().slice(0, 4), 10);
            } else if (typeof rawYear === "number") {
              itemYear = rawYear;
            }
          }
          if (Array.isArray(metaData.files)) {
            // Filtrar solo streams directos reproducibles por Chromium sin transcodificación.
            // Excluir OGV/AVI/Cinepack (no soportado nativo o sin CORS HLS) — solo mp4/m3u8/webm/mkv.
            // Regla generalizable por formato/metadata, no hardcode de BigBuckBunny.
            const candidates: any[] = (metaData.files as any[]).filter((f: any) => {
              const name = String(f.name || "").trim();
              if (!name) return false;
              // solo extensiones directas que Chromium reproduce nativo (mp4 via avc, m3u8 via hls.js)
              // Rechaza .ogv, .avi, .gif, .jpg, .torrent, .xml, etc.
              return /\.(mp4|m3u8|webm|mkv)(\?|#|$)/i.test(name);
            });

            // Ordenar: extensión > formato (h264 primero) > source derivative > tamaño/altura menor (carga más rápida) > nombre
            candidates.sort((a: any, b: any) => {
              const aName = String(a.name || "");
              const bName = String(b.name || "");
              const aExt = extPriority(aName);
              const bExt = extPriority(bName);
              if (aExt !== bExt) return aExt - bExt;

              const aFmt = formatScore(a.format);
              const bFmt = formatScore(b.format);
              if (aFmt !== bFmt) return aFmt - bFmt;

              const aSrc = sourcePriority(a.source);
              const bSrc = sourcePriority(b.source);
              if (aSrc !== bSrc) return aSrc - bSrc;

              // Preferir altura menor para E2E más rápido si mismo formato (240p < 360p < 720p) y size pequeño
              const aH = parseInt(String(a.height || ""), 10);
              const bH = parseInt(String(b.height || ""), 10);
              const aHasH = !isNaN(aH);
              const bHasH = !isNaN(bH);
              if (aHasH && bHasH && aH !== bH) return aH - bH;

              const aSize = Number(a.size);
              const bSize = Number(b.size);
              const aHasSize = !isNaN(aSize) && aSize > 0;
              const bHasSize = !isNaN(bSize) && bSize > 0;
              if (aHasSize && bHasSize && aSize !== bSize) return aSize - bSize;

              return aName.localeCompare(bName);
            });

            candidates.forEach((f: any) => {
              const name = String(f.name || "").trim();
              // Usar host CORS para que <video crossorigin="anonymous"> reciba ACAO *
              // (archive.org/download/* no envía CORS y nunca alcanza readyState>=2)
              detectedStreams.push(buildCorsUrl(identifier, name));
            });
          }
        }
      } catch {}
    }

    // Fallbacks del año real: fecha dentro de la descripción/título del ítem
    if (!itemYear) itemYear = extractYearFromText(desc) || extractYearFromText(title);

    // Defecto #23: si el API no listó archivos, NO inventar {identifier}.mp4 a ciegas.
    // Validar existencia con HEAD; usar host CORS para que el video sea reproducible.
    if (detectedStreams.length === 0 && identifier) {
      const guessedCors = `${CORS_BASE}/${identifier}/${encodeURIComponent(identifier)}.mp4`;
      if (await this.headExists(guessedCors)) {
        detectedStreams.push(guessedCors);
      }
    }

    return {
      page_type: "detail",
      content_type: "open_archive",
      title: cleanQueryTitle(title),
      description: desc,
      poster_url: poster,
      banner_url: poster,
      // Defecto #24: sin rating real en el API -> 0 para que el enriquecimiento
      // complete el hueco (antes: 8.2 fijo).
      rating: 0,
      // Año real del ítem; 0 (desconocido) si nada lo declara — nunca 1968 fijo.
      year: itemYear || 0,
      status: "Dominio Público",
      genres: ["Cine Clásico", "Dominio Público", "Película"],
      detected_streams: detectedStreams,
      episodes: [
        {
          number: 1,
          title: "Película Completa",
          url: detectedStreams[0] || archiveUrl,
        },
      ],
      catalog_items: [],
    };
  }

  async extractStream(targetUrl: string): Promise<{ stream_url: string; all_available_streams: string[]; title?: string }> {
    const res = await this.analyze(targetUrl);
    const streams = res.detected_streams || [];
    return {
      stream_url: streams[0] || targetUrl,
      all_available_streams: streams.length > 0 ? streams : [targetUrl],
      title: res.title,
    };
  }
}
