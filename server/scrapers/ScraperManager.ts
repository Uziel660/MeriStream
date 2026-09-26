import { BaseScraperAdapter } from "./BaseAdapter";
import { DirectStreamAdapter } from "./adapters/DirectStreamAdapter";
import { ArchiveOrgAdapter } from "./adapters/ArchiveOrgAdapter";
import { TvMazeAdapter } from "./adapters/TvMazeAdapter";
import { AnimeAv1Adapter } from "./adapters/AnimeAv1Adapter";
import { AnimeFlvAdapter } from "./adapters/AnimeFlvAdapter";
import { GenericAdapter } from "./adapters/GenericAdapter";
import { LaMovieAdapter } from "./adapters/LaMovieAdapter";
import { LatAnimeAdapter } from "./adapters/LatAnimeAdapter";
import { TioAnimeAdapter } from "./adapters/TioAnimeAdapter";
import { TioPlusAdapter } from "./adapters/TioPlusAdapter";
import { CinecalidadAdapter } from "./adapters/CinecalidadAdapter";
import { VerAnimesAdapter } from "./adapters/VerAnimesAdapter";
import { DoramasflixAdapter } from "./adapters/DoramasflixAdapter";
import { DoramasYTAdapter } from "./adapters/DoramasYTAdapter";
import { DoramasiaAdapter } from "./adapters/DoramasiaAdapter";
import { TudoramaAdapter } from "./adapters/TudoramaAdapter";
import { TubePelisAdapter } from "./adapters/TubePelisAdapter";
import { HiAnimesAdapter } from "./adapters/HiAnimesAdapter";
import { GnulaAdapter } from "./adapters/GnulaAdapter";
import { ZokoAnimeAdapter } from "./adapters/ZokoAnimeAdapter";
import { compareProviderIds } from "../providers/providerPolicy";

import { UniversalAnalysisResult, ExtractedCatalogItem } from "../types";

/**
 * Adapter registry. Runtime priority is centralized in providerPolicy so the
 * same source ordering can later be reused by crawlers, health checks and the UI.
 */
export class ScraperManager {
  private static instance: ScraperManager;
  private adapters: BaseScraperAdapter[] = [];
  private fallbackAdapter: BaseScraperAdapter;

  private constructor() {
    this.fallbackAdapter = new GenericAdapter();

    // Native/direct first, then maintained Spanish-first sources, then legacy fallbacks.
    this.registerAdapter(new DirectStreamAdapter());
    this.registerAdapter(new AnimeAv1Adapter());
    this.registerAdapter(new AnimeFlvAdapter());
    this.registerAdapter(new CinecalidadAdapter());
    this.registerAdapter(new LaMovieAdapter());
    this.registerAdapter(new GnulaAdapter());
    this.registerAdapter(new ArchiveOrgAdapter());
    this.registerAdapter(new HiAnimesAdapter());
    this.registerAdapter(new LatAnimeAdapter());
    this.registerAdapter(new ZokoAnimeAdapter());
    this.registerAdapter(new TioAnimeAdapter());
    this.registerAdapter(new VerAnimesAdapter());
    this.registerAdapter(new DoramasflixAdapter());
    this.registerAdapter(new DoramasiaAdapter());
    this.registerAdapter(new DoramasYTAdapter());
    this.registerAdapter(new TudoramaAdapter());
    this.registerAdapter(new TioPlusAdapter());
    this.registerAdapter(new TubePelisAdapter());
    this.registerAdapter(new TvMazeAdapter());
  }

  public static getInstance(): ScraperManager {
    if (!ScraperManager.instance) {
      ScraperManager.instance = new ScraperManager();
    }
    return ScraperManager.instance;
  }

  public registerAdapter(adapter: BaseScraperAdapter): void {
    const existingIndex = this.adapters.findIndex((a) => a.id === adapter.id);
    if (existingIndex >= 0) {
      this.adapters[existingIndex] = adapter;
    } else {
      this.adapters.push(adapter);
    }
    this.adapters.sort((a, b) => compareProviderIds(a.id, b.id));
  }

  public getAdapter(url: string, explicitAdapterId?: string): BaseScraperAdapter {
    if (explicitAdapterId) {
      const explicit = this.adapters.find((a) => a.id === explicitAdapterId);
      if (explicit) return explicit;
    }

    const matched = this.adapters.find((a) => a.canHandle(url));
    return matched || this.fallbackAdapter;
  }

  public getAdapterById(id: string): BaseScraperAdapter | undefined {
    return this.adapters.find((a) => a.id === id) || (this.fallbackAdapter.id === id ? this.fallbackAdapter : undefined);
  }

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

  public async analyze(url: string, explicitType?: "auto" | "catalog" | "detail" | "stream", explicitAdapterId?: string): Promise<UniversalAnalysisResult> {
    const adapter = this.getAdapter(url, explicitAdapterId);
    return adapter.analyze(url, explicitType);
  }

  public async extractStream(url: string, explicitAdapterId?: string): Promise<{ stream_url: string; all_available_streams: string[]; title?: string }> {
    const adapter = this.getAdapter(url, explicitAdapterId);
    return adapter.extractStream(url);
  }

  public async extractCatalog(catalogUrl: string, explicitAdapterId?: string): Promise<ExtractedCatalogItem[]> {
    const result = await this.analyze(catalogUrl, "catalog", explicitAdapterId);
    return result.catalog_items || [];
  }
}

