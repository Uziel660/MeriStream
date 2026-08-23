import fs from "fs";
import path from "path";
import { UniversalAnalysisResult, ExtractedCatalogItem, ScraperPreset } from "./types";
import { ScraperManager } from "./scrapers/ScraperManager";

export const PRESET_SOURCES: ScraperPreset[] = [
  {
    id: "anime-animeflv",
    name: "AnimeFLV Catálogo (Anime Español)",
    category: "anime",
    description: "Directorio /browse de animes con temporadas completas y servidores multi-fuente.",
    example_url: "https://www3.animeflv.net/browse",
    icon: "Tv",
  },
  {
    id: "movies-lamovie",
    name: "LaMovie Catálogo (Películas Latino)",
    category: "movies",
    description: "Catálogo paginado vía API wp-api/v1; fichas con embeds multi-servidor.",
    example_url: "https://lamovie.org/wp-api/v1/listing/movies?page=1&postType=movies&postsPerPage=24",
    icon: "Film",
  },
  {
    id: "movies-cinecalidad",
    name: "Cinecalidad Catálogo (HD)",
    category: "movies",
    description: "Home-listado de películas en calidad HD con streams Goodstream/HLS directos.",
    example_url: "https://www.cinecalidad.am/",
    icon: "Film",
  },
  {
    id: "movies-tubepelis",
    name: "TubePelis Catálogo (Castellano)",
    category: "movies",
    description: "Listado de películas; fichas con servidores Byse cifrados AES-256-GCM descifrados JIT.",
    example_url: "https://www.tubepelis.com/peliculas.html",
    icon: "Film",
  },
  {
    id: "movies-tioplus",
    name: "TioPlus Catálogo (Multi-Fuente)",
    category: "movies",
    description: "Directorio paginado de películas con múltiples servidores embebidos.",
    example_url: "https://tioplus.app/peliculas",
    icon: "Film",
  },
  {
    id: "anime-latanime",
    name: "LatAnime Catálogo (Sub/Latino)",
    category: "anime",
    description: "Directorio completo de animes; episodios MP4Upload con Referer forzado.",
    example_url: "https://latanime.org/animes",
    icon: "Tv",
  },
  {
    id: "anime-tioanime",
    name: "TioAnime Catálogo (Multi-Servidor)",
    category: "anime",
    description: "Directorio completo; embeds Mega/YourUpload/ok.ru priorizados sobre efímeros.",
    example_url: "https://tioanime.com/directorio",
    icon: "Tv",
  },
  {
    id: "anime-veranimes",
    name: "VerAnimes Catálogo (Espejo WWV)",
    category: "anime",
    description: "Directorio completo; StreamWish con failover automático a embed si el CDN cae.",
    example_url: "https://wwv.veranimes.net/animes",
    icon: "Tv",
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

const PRESET_OVERRIDES_PATH = path.join(process.cwd(), "prisma", "custom_presets.json");

export function getCustomPresetOverrides(): Record<string, string> {
  try {
    if (fs.existsSync(PRESET_OVERRIDES_PATH)) {
      const data = fs.readFileSync(PRESET_OVERRIDES_PATH, "utf-8");
      return JSON.parse(data) || {};
    }
  } catch (e) {
    console.error("Error leyendo custom_presets.json:", e);
  }
  return {};
}

export function saveCustomPresetOverride(presetId: string, url: string): void {
  try {
    const current = getCustomPresetOverrides();
    if (!url || !url.trim()) {
      delete current[presetId];
    } else {
      current[presetId] = url.trim();
    }
    const dir = path.dirname(PRESET_OVERRIDES_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PRESET_OVERRIDES_PATH, JSON.stringify(current, null, 2), "utf-8");
  } catch (e) {
    console.error("Error guardando custom_presets.json:", e);
  }
}

export function resetCustomPresetOverride(presetId: string): void {
  try {
    const current = getCustomPresetOverrides();
    delete current[presetId];
    fs.writeFileSync(PRESET_OVERRIDES_PATH, JSON.stringify(current, null, 2), "utf-8");
  } catch (e) {
    console.error("Error restableciendo custom_presets.json:", e);
  }
}

export function getActivePresets(): (ScraperPreset & { original_url: string; is_custom: boolean })[] {
  const overrides = getCustomPresetOverrides();
  return PRESET_SOURCES.map((p) => ({
    ...p,
    original_url: p.example_url,
    is_custom: Boolean(overrides[p.id]),
    example_url: overrides[p.id] || p.example_url,
  }));
}

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
