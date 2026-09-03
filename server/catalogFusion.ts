import { ExtractedEpisode, SourceLinkInput } from "./types";
import { classifySourceKind } from "./resolutionMetadata";
import { canonicalCatalogUrl } from "./catalogIntegrity";

/**
 * Normaliza el resultado de detalle de un adaptador sin perder sus fuentes
 * secundarias. Esta frontera existe para que el worker no tenga que conocer
 * la forma interna de cada scraper.
 */
export interface NormalizedCatalogEpisode {
  number: number;
  title: string;
  url: string;
  sources?: SourceLinkInput[];
}

interface RawCatalogEpisode extends Partial<ExtractedEpisode> {
  episode_number?: number;
  source_url?: string;
  sources?: Array<Partial<SourceLinkInput> & { url?: unknown }>;
}

function cleanUrl(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sourceKey(url: string): string {
  const clean = cleanUrl(url);
  const kind = classifySourceKind(clean);
  return (kind === "page" || kind === "embed" ? canonicalCatalogUrl(clean) : clean).toLowerCase();
}

/**
 * Convierte un episodio devuelto por cualquier adaptador en el contrato que
 * consume quickSyncKnownShow. La URL primaria se conserva y las fuentes
 * adicionales sobreviven con source_site/link_type/host/is_verified.
 */
export function normalizeExtractedEpisode(raw: RawCatalogEpisode, fallbackSite: string): NormalizedCatalogEpisode | null {
  const primaryUrl = cleanUrl(raw.url || raw.source_url);
  const normalizedSources: SourceLinkInput[] = [];
  const seen = new Set<string>();

  for (const source of Array.isArray(raw.sources) ? raw.sources : []) {
    const url = cleanUrl(source?.url);
    if (!url) continue;
    const key = sourceKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    normalizedSources.push({
      url,
      source_site: cleanUrl(source.source_site) || fallbackSite,
      link_type: cleanUrl(source.link_type) || undefined,
      host: cleanUrl(source.host) || undefined,
      is_verified: source.is_verified === true,
      language: cleanUrl(source.language) || undefined,
      audio_language: cleanUrl(source.audio_language) || undefined,
      subtitle_language: cleanUrl(source.subtitle_language) || undefined,
      subtitles: Array.isArray(source.subtitles) ? source.subtitles : undefined,
    });
  }

  const url = primaryUrl || normalizedSources[0]?.url || "";
  if (!url) return null;

  const numberValue = Number(raw.number ?? raw.episode_number);
  const number = Number.isFinite(numberValue) && numberValue > 0 ? numberValue : 1;
  const title = cleanUrl(raw.title) || `Episodio ${number}`;

  return {
    number,
    title,
    url,
    sources: normalizedSources.length > 0 ? normalizedSources : undefined,
  };
}

/** Normaliza una lista preservando el orden del adaptador y eliminando vacíos. */
export function normalizeExtractedEpisodes(rawEpisodes: unknown, fallbackSite: string): NormalizedCatalogEpisode[] {
  if (!Array.isArray(rawEpisodes)) return [];
  return rawEpisodes
    .map((episode) => normalizeExtractedEpisode((episode || {}) as RawCatalogEpisode, fallbackSite))
    .filter((episode): episode is NormalizedCatalogEpisode => episode !== null);
}
