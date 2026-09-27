import fs from "fs";
import path from "path";
import { UniversalAnalysisResult, ExtractedCatalogItem, ScraperPreset } from "./types";
import { ScraperManager } from "./scrapers/ScraperManager";
import { dedupeCatalogItems } from "./catalogIntegrity";

export const PRESET_SOURCES: ScraperPreset[] = [
  {
    id: "doramas-tudorama",
    name: "Tudorama (Catálogo asiático)",
    category: "series",
    description: "Catálogo WordPress paginado de Tudorama con episodios y servidores resueltos JIT.",
    example_url: "https://tudorama.com/genero/series/",
    icon: "Tv",
  },
  {
    id: "movies-tudorama",
    name: "Tudorama Películas",
    category: "movies",
    description: "Películas de Tudorama con locators canónicos y servidores WStream consultados al reproducir.",
    example_url: "https://tudorama.com/genero/peliculas/",
    icon: "Film",
  },
  {
    id: "doramas-doramasia",
    name: "Doramasia (Catálogo asiático)",
    category: "series",
    description: "Catálogo GraphQL de doramas coreanos, chinos, tailandeses y japoneses con subtítulos en español y variantes de audio cuando están publicadas.",
    example_url: "https://doramasia.com/doramas",
    icon: "Tv",
  },
  {
    id: "movies-doramasia",
    name: "Doramasia Películas",
    category: "movies",
    description: "Películas asiáticas con enlaces JIT y servidores Primeload/Streamwish priorizados.",
    example_url: "https://doramasia.com/peliculas",
    icon: "Film",
  },
  {
    id: "doramas-doramasflix",
    name: "Doramasflix (Doramas / K-Dramas)",
    category: "series",
    description: "Catálogo completo de doramas, K-Dramas y series asiáticas con servidores Primeload/Filemoon/VOE.",
    example_url: "https://doramasflix.io/doramas",
    icon: "Tv",
  },
  {
    id: "movies-doramasflix",
    name: "Doramasflix Películas",
    category: "movies",
    description: "Películas asiáticas en español latino y sub español.",
    example_url: "https://doramasflix.io/peliculas",
    icon: "Film",
  },
  {
    id: "variety-doramasflix",
    name: "Doramasflix Variedades",
    category: "series",
    description: "Programas de variedad y TV shows asiáticos.",
    example_url: "https://doramasflix.io/variedades",
    icon: "Layers",
  },
  {
    id: "anime-animeflv",
    name: "AnimeFLV Catálogo (Anime Español)",
    category: "anime",
    description: "Directorio vivo de animes con temporadas completas y servidores multi-fuente.",
    example_url: "https://animeflv.or.at/anime/",
    icon: "Tv",
  },
  {
    id: "anime-jkanime",
    name: "JKAnime Catálogo (Anime)",
    category: "anime",
    description: "Directorio completo de JKanime con temporadas y servidores multi-fuente.",
    example_url: "https://jkanime.net/directorio/",
    icon: "Tv",
  },
  {
    id: "movies-gnula",
    name: "GNULA HD Películas",
    category: "movies",
    description: "Catálogo completo de películas GNULA HD con resolución JIT de sus páginas canónicas.",
    example_url: "https://ww3.gnulahd.nu/ver/peliculas/?page=1&__epix=1",
    icon: "Film",
  },
  {
    id: "series-gnula",
    name: "GNULA HD Series",
    category: "series",
    description: "Catálogo completo de series GNULA HD con temporadas y episodios multi-fuente.",
    example_url: "https://ww3.gnulahd.nu/ver/series/?page=1&__epix=1",
    icon: "Layers",
  },
  {
    id: "anime-gnula",
    name: "GNULA HD Anime",
    category: "anime",
    description: "Catálogo completo de anime GNULA HD con resolución JIT del reproductor embebido.",
    example_url: "https://ww3.gnulahd.nu/ver/anime/?page=1&__epix=1",
    icon: "Tv",
  },
  {
    id: "anime-hianimes",
    name: "HiAnimes Catálogo (Anime multi-host)",
    category: "anime",
    description: "Catálogo paginado vía API pública con servidores separados para subtítulos y doblaje.",
    example_url: "https://hianimes.se/filter?type=All&page=1",
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
    id: "series-lamovie",
    name: "LaMovie Series (TV)",
    category: "series",
    description: "1,089 series de TV vía API wp-api/v1 (postType=tvshows); items con póster/géneros/imdb.",
    example_url: "https://lamovie.org/wp-api/v1/listing/movies?page=1&postType=tvshows&postsPerPage=24",
    icon: "Layers",
  },
  {
    id: "anime-lamovie",
    name: "LaMovie Animes",
    category: "anime",
    description: "970 animes vía API wp-api/v1 (postType=animes); items con póster/géneros/imdb.",
    example_url: "https://lamovie.org/wp-api/v1/listing/movies?page=1&postType=animes&postsPerPage=24",
    icon: "Tv",
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
    // Defecto #22: night_of_the_living_dead fue oscurecido por Archive.org
    // (is_dark desde 2025-02): sin archivos y con .mp4 inventado que da 403.
    example_url: "https://archive.org/details/his_girl_friday",
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

export interface CatalogPageResult {
  page_url: string;
  items: ExtractedCatalogItem[];
  error: string | null;
}

/**
 * Extrae varias páginas de catálogo con concurrencia limitada (pool fijo).
 * - `beforeRequest` se espera ANTES de cada fetch: ahí vive el rate-limit
 *   cortés por host (token-bucket) que espacia las peticiones aunque el pool
 *   corra en paralelo (solapa RTT sin aumentar la carga al sitio).
 * - Un fallo en una página NO propaga: se devuelve como { error } y el resto
 *   del lote sigue. El orden del array de resultados respeta al de entrada.
 */
export async function extractCatalogListingsBatch(
  pageUrls: string[],
  opts: { concurrency?: number; beforeRequest?: () => Promise<void>; explicitAdapterId?: string } = {}
): Promise<CatalogPageResult[]> {
  const concurrency = Math.max(1, Math.min(8, Math.round(opts.concurrency ?? 3)));
  const results: CatalogPageResult[] = new Array(pageUrls.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = cursor++;
      if (idx >= pageUrls.length) return;
      const url = pageUrls[idx];
      try {
        if (opts.beforeRequest) await opts.beforeRequest();
        const items = await extractCatalogListing(url, opts.explicitAdapterId);
        results[idx] = { page_url: url, items: dedupeCatalogItems(items || []) as ExtractedCatalogItem[], error: null };
      } catch (e: any) {
        results[idx] = { page_url: url, items: [], error: String(e?.message || e) };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, pageUrls.length) }, () => worker()));
  return results;
}
