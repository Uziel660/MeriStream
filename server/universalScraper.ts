import { UniversalAnalysisResult, ExtractedCatalogItem, ScraperPreset } from "./types";
import { ScraperManager } from "./scrapers/ScraperManager";

export const PRESET_SOURCES: ScraperPreset[] = [
  {
    id: "anime-animeflv",
    name: "AnimeFLV / JKanime (Anime en Español)",
    category: "anime",
    description: "Portales de anime con temporadas completas, lista de episodios y servidores multi-fuente.",
    example_url: "https://www3.animeflv.net/anime/sousou-no-frieren",
    icon: "Tv",
  },
  {
    id: "movies-cuevana",
    name: "Películas & Series Web (Streaming)",
    category: "movies",
    description: "Directorio de películas y series con reproductores en línea y opciones de calidad.",
    example_url: "https://cuevana.biz/pelicula/oppenheimer",
    icon: "Film",
  },
  {
    id: "series-tvmaze",
    name: "TV Shows Internacionales (TVMaze)",
    category: "series",
    description: "Series de televisión mundiales con temporadas, sinopsis, reparto y fechas oficiales.",
    example_url: "https://www.tvmaze.com/shows/169/breaking-bad",
    icon: "Layers",
  },
  {
    id: "archive-org",
    name: "Internet Archive (Cine y Multimedia Libre)",
    category: "archive",
    description: "Películas clásicas de dominio público, animación y documentales con streams directos MP4/HLS.",
    example_url: "https://archive.org/details/night_of_the_living_dead",
    icon: "Database",
  },
  {
    id: "open-hls",
    name: "Direct HLS Stream (.m3u8)",
    category: "direct",
    description: "Enlace directo de manifiesto HLS adaptativo con soporte de múltiples resoluciones.",
    example_url: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
    icon: "Play",
  },
  {
    id: "open-mp4",
    name: "Direct Video File (.mp4 / .webm)",
    category: "direct",
    description: "Enlace directo a archivo de video accesible por HTTP/HTTPS.",
    example_url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4",
    icon: "Sparkles",
  }
];

export const scraperManager = ScraperManager.getInstance();

/**
 * Universal Scraper Entrypoint: delegates to the appropriate specialized Adapter (Strategy Pattern)
 */
export async function analyzeUniversalUrl(input: string, explicitType?: "auto" | "catalog" | "detail" | "stream", explicitAdapterId?: string): Promise<UniversalAnalysisResult> {
  return scraperManager.analyze(input, explicitType, explicitAdapterId);
}

/**
 * Extracts live playable stream URLs in real time (Just-In-Time) from any URL
 */
export async function extractStreamFromUrl(targetUrl: string, explicitAdapterId?: string): Promise<{ stream_url: string; all_available_streams: string[]; title?: string }> {
  return scraperManager.extractStream(targetUrl, explicitAdapterId);
}

/**
 * Extracts catalog items from a given page URL (used by background task worker for pagination)
 */
export async function extractCatalogListing(catalogUrl: string, explicitAdapterId?: string): Promise<ExtractedCatalogItem[]> {
  return scraperManager.extractCatalog(catalogUrl, explicitAdapterId);
}
