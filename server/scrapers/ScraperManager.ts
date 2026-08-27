import { BaseScraperAdapter } from "./BaseAdapter";
import { DirectStreamAdapter } from "./adapters/DirectStreamAdapter";
import { ArchiveOrgAdapter } from "./adapters/ArchiveOrgAdapter";
import { TvMazeAdapter } from "./adapters/TvMazeAdapter";
import { AnimeFlvAdapter } from "./adapters/AnimeFlvAdapter";
import { GenericAdapter } from "./adapters/GenericAdapter";
import { LaMovieAdapter } from "./adapters/LaMovieAdapter";
import { LatAnimeAdapter } from "./adapters/LatAnimeAdapter";
import { TioAnimeAdapter } from "./adapters/TioAnimeAdapter";
import { TioPlusAdapter } from "./adapters/TioPlusAdapter";
import { CinecalidadAdapter } from "./adapters/CinecalidadAdapter";
import { VerAnimesAdapter } from "./adapters/VerAnimesAdapter";
import { DoramasflixAdapter } from "./adapters/DoramasflixAdapter";

import { UniversalAnalysisResult, ExtractedCatalogItem } from "../types";

export class ScraperManager {
  private static instance: ScraperManager;
  private adapters: BaseScraperAdapter[] = [];
  private fallbackAdapter: BaseScraperAdapter;

  private constructor() {
    this.fallbackAdapter = new GenericAdapter();

    // Register specialized domain adapters in priority order
    this.registerAdapter(new DirectStreamAdapter());
    this.registerAdapter(new ArchiveOrgAdapter());
    this.registerAdapter(new TvMazeAdapter());
    this.registerAdapter(new AnimeFlvAdapter());
    this.registerAdapter(new LaMovieAdapter());
    this.registerAdapter(new LatAnimeAdapter());
    this.registerAdapter(new TioAnimeAdapter());
    this.registerAdapter(new TioPlusAdapter());
    // TubePelis deshabilitado: el sitio está caído (404/500 en detalle y home).
    // No se registra para evitar fetches muertos; los 5 shows remanentes en BD
    // quedan sin fuente válida y se re-derivarán desde otra plataforma.
    // this.registerAdapter(new TubePelisAdapter());
    this.registerAdapter(new CinecalidadAdapter());
    this.registerAdapter(new VerAnimesAdapter());
    this.registerAdapter(new DoramasflixAdapter());
  }

  public static getInstance(): ScraperManager {
    if (!ScraperManager.instance) {
      ScraperManager.instance = new ScraperManager();
    }
    return ScraperManager.instance;
  }

  /**
   * Registra un nuevo adaptador en el pool de scrapers
   */
  public registerAdapter(adapter: BaseScraperAdapter): void {
    const existingIndex = this.adapters.findIndex((a) => a.id === adapter.id);
    if (existingIndex >= 0) {
      this.adapters[existingIndex] = adapter;
    } else {
      this.adapters.push(adapter);
    }
  }

  /**
   * Obtiene el adaptador más adecuado para una URL específica.
   */
  public getAdapter(url: string, explicitAdapterId?: string): BaseScraperAdapter {
    if (explicitAdapterId) {
      const explicit = this.adapters.find((a) => a.id === explicitAdapterId);
      if (explicit) return explicit;
    }

    const matched = this.adapters.find((a) => a.canHandle(url));
    return matched || this.fallbackAdapter;
  }

  /**
   * Obtiene un adaptador por su identificador único
   */
  public getAdapterById(id: string): BaseScraperAdapter | undefined {
    return this.adapters.find((a) => a.id === id) || (this.fallbackAdapter.id === id ? this.fallbackAdapter : undefined);
  }

  /**
   * Lista todos los adaptadores disponibles y sus dominios soportados
   */
  public getAvailableAdapters(): Array<{ id: string; name: string; supportedDomains: string[] }> {
    const list = this.adapters.map((a) => ({
      id: a.id,
      name: a.name,
      supportedDomains: a.supportedDomains,
    }));
    list.push({
      id: this.fallbackAdapter.id,
      name: this.fallbackAdapter.name,
      supportedDomains: this.fallbackAdapter.supportedDomains,
    });
    return list;
  }

  /**
   * Ejecuta el análisis universal delegando al adaptador correspondiente
   */
  public async analyze(url: string, explicitType?: "auto" | "catalog" | "detail" | "stream", explicitAdapterId?: string): Promise<UniversalAnalysisResult> {
    const adapter = this.getAdapter(url, explicitAdapterId);
    return adapter.analyze(url, explicitType);
  }

  /**
   * Extrae streams Just-In-Time delegando al adaptador
   */
  public async extractStream(url: string, explicitAdapterId?: string): Promise<{ stream_url: string; all_available_streams: string[]; title?: string }> {
    const adapter = this.getAdapter(url, explicitAdapterId);
    return adapter.extractStream(url);
  }

  /**
   * Extrae listado de catálogo delegando al adaptador
   */
  public async extractCatalog(catalogUrl: string, explicitAdapterId?: string): Promise<ExtractedCatalogItem[]> {
    const result = await this.analyze(catalogUrl, "catalog", explicitAdapterId);
    return result.catalog_items || [];
  }
}
