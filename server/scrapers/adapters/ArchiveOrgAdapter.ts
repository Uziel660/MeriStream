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
            metaData.files.forEach((f: any) => {
              const name: string = f.name || "";
              if (name.endsWith(".mp4") || name.endsWith(".m3u8") || name.endsWith(".ogv")) {
                detectedStreams.push(`https://archive.org/download/${identifier}/${encodeURIComponent(name)}`);
              }
            });
          }
        }
      } catch {}
    }

    // Fallbacks del año real: fecha dentro de la descripción/título del ítem
    if (!itemYear) itemYear = extractYearFromText(desc) || extractYearFromText(title);

    // Defecto #23: si el API no listó archivos, NO inventar {identifier}.mp4 a ciegas.
    // Validar existencia con HEAD; si no existe, no guardar ninguna fuente falsa.
    if (detectedStreams.length === 0 && identifier) {
      const guessedMp4 = `https://archive.org/download/${identifier}/${identifier}.mp4`;
      if (await this.headExists(guessedMp4)) {
        detectedStreams.push(guessedMp4);
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
