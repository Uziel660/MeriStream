// src/App.tsx
import { useEffect, useState, useMemo, useCallback } from 'react';

import { UnifiedHeader } from './components/UnifiedHeader';
import { HeroBanner } from './components/HeroBanner';
import { MediaRow } from './components/MediaRow';
import { CatalogFilters, type SortMode } from './components/CatalogFilters';
import { MediaCard } from './components/MediaCard';
import { MediaDetailsModal } from './components/MediaDetailsModal';
import { HLSPlayerModal } from './components/HLSPlayerModal';
import { AdminPanel } from './components/AdminPanel';
import { ContinueWatching, type WatchProgress } from './components/ContinueWatching';
import { BentoCollection } from './components/BentoCollection';
import { AuthModal } from './components/AuthModal';
import { ExploreCatalogView } from './components/ExploreCatalogView';
import { useAuth } from './contexts/AuthContext';
import { thumbBackdropUrl } from './utils/imageSizes';
import { isEmbedUrl } from './utils/streamOptimizer';
import { api } from './api/client';
import { normalizeText, searchShows } from './utils/searchUtils';
import { displayEpisodeTitle } from './utils/episodeLabels';
import { RefreshCw, Film, Tv, ArrowUpRight, Sparkles } from 'lucide-react';
import type { Show, Episode } from './types';

const STORAGE_CONTINUE_KEY = 'nitiflix_continue_watching_v1';
// Bumped after the main-path provider cutover so a browser cannot briefly
// render cards that are now admin/legacy-only while the fresh request loads.
// Bumped after the unified TMDB rail started interleaving movie/series/anime;
// profiles with the old movie-only payload must fetch the corrected catalog.
const CATALOG_CACHE_KEY = 'nitiflix_catalog_cache_v4';
const RETIRED_CATALOG_CACHE_KEY = 'nitiflix_catalog_cache_v1';
const CATALOG_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const PUBLIC_CATALOG_BATCH_SIZE = 60;
// The unified backend batch spans three TMDB pages per kind (20 rows each).
// Advance by that width when loading the next batch so pages do not overlap.
const PUBLIC_CATALOG_PAGE_STEP = 3;

/** Nunca renderizar "Episodio undefined" (#2): fallback al número de episodio. */
function safeEpisodeTitle(episode: { title?: string; episode_number?: number }): string {
  return displayEpisodeTitle(episode.title, episode.episode_number);
}

/**
 * Subtitle URLs are issued by our backend proxy. External provider URLs are
 * intentionally dropped at this boundary so the browser never contacts a
 * subtitle host directly.
 */
function internalSubtitleUrl(raw: unknown): string | null {
  const value = String(raw || '').trim();
  const internalPath = /^\/api\/v1\/subtitles\/file\/[a-f0-9]{32}\.vtt(?:\?.*)?$/i;
  if (internalPath.test(value)) return value;
  if (!/^https?:\/\//i.test(value) || typeof window === 'undefined') return null;
  try {
    const parsed = new URL(value, window.location.origin);
    return parsed.origin === window.location.origin && internalPath.test(`${parsed.pathname}${parsed.search}`)
      ? `${parsed.pathname}${parsed.search}`
      : null;
  } catch {
    return null;
  }
}

function mapInternalSubtitleTrack(raw: any, id: string): any | null {
  const url = internalSubtitleUrl(raw?.url || raw?.src || raw?.file);
  if (!url) return null;
  return {
    id,
    label: raw?.label || raw?.language || 'Subtítulo',
    language: raw?.language || raw?.lang || 'und',
    url,
    is_default: Boolean(raw?.is_default || raw?.default),
  };
}

function mapCatalogShow(s: any): Show {
  return {
    id: s.id || `show-${Math.random()}`,
    title: s.title || 'Sin Título',
    tmdb_id: s.tmdb_id ?? null,
    imdb_id: s.imdb_id ?? null,
    anilist_id: s.anilist_id ?? null,
    mal_id: s.mal_id ?? null,
    kitsu_id: s.kitsu_id ?? null,
    kind: s.kind || s.category || undefined,
    original_title: s.original_title || null,
    english_title: s.english_title || null,
    japanese_title: s.japanese_title || null,
    description: s.description || s.synopsis || '',
    synopsis: s.description || s.synopsis || '',
    poster_url: s.poster_url || '',
    banner_url: s.banner_url || s.poster_url || '',
    backdrop_url: s.backdrop_url || s.banner_url || '',
    poster_path: s.poster_path ?? null,
    backdrop_path: s.backdrop_path ?? null,
    category: s.category || 'movie',
    rating: Number(s.rating || 0),
    year: s.year ?? null,
    genres: Array.isArray(s.genres)
      ? s.genres
      : String(s.genres || '').split(',').map((g: string) => g.trim()).filter(Boolean),
    episode_count: s.episode_count || s._count?.episodes || 0,
    is_trending: Boolean(s.is_trending),
    sources: {
      master_m3u8: s.sources?.master_m3u8 || '',
      fallback_mp4: null,
      qualities: [],
      subtitles: [],
    },
  } as Show;
}

export function App() {
  const { user, isAuthenticated } = useAuth();
  const [shows, setShows] = useState<Show[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [serverSearchResults, setServerSearchResults] = useState<Show[]>([]);
  const [activeFilter, setActiveFilter] = useState<string>('all');
  const [gridPageSize, setGridPageSize] = useState(100);
  const [yearFilter, setYearFilter] = useState<number | null>(null);
  const [sortBy, setSortBy] = useState<SortMode>('recientes');
  const [catalogPageSize, setCatalogPageSize] = useState(100);
  const [publicCatalogPage, setPublicCatalogPage] = useState(1);
  const [hasMorePublicCatalog, setHasMorePublicCatalog] = useState(true);
  const [isLoadingMoreCatalog, setIsLoadingMoreCatalog] = useState(false);
  const [allGenresList, setAllGenresList] = useState<string[]>([]);
  const [exploreGenreFilter, setExploreGenreFilter] = useState<string | null>(null);

  // Continue Watching State
  const [continueWatchingItems, setContinueWatchingItems] = useState<WatchProgress[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_CONTINUE_KEY);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  // Recommendation Rails & Ultimate Hero Pick from Backend
  const [recommendationRails, setRecommendationRails] = useState<Array<{
    id: string;
    title: string;
    subtitle?: string;
    reason?: string;
    shows: Show[];
  }>>([]);
  const [heroRecommendation, setHeroRecommendation] = useState<Show | null>(null);
  const [isLoadingRecs, setIsLoadingRecs] = useState<boolean>(false);

  // Modal States
  const [selectedShowId, setSelectedShowId] = useState<string | null>(null);
  const [playingStreamData, setPlayingStreamData] = useState<any | null>(null);
  const [isAdminOpen, setIsAdminOpen] = useState(false);
  const [orphanNotice, setOrphanNotice] = useState<string | null>(null);

  // Arnés local para validar VidSrc directamente en el reproductor interno.
  // Solo se activa en Vite dev mediante ?vidsrc-local-test=1; no forma parte
  // del flujo de producción ni depende del catálogo persistido.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const params = new URLSearchParams(window.location.search);
    if (!params.has('vidsrc-local-test')) return;

    const kind = params.get('vidsrc-kind') === 'series' ? 'series' : 'movie';
    const tmdbId = Number(params.get('vidsrc-tmdb') || (kind === 'series' ? 1396 : 550));
    const season = Number(params.get('vidsrc-season') || 1);
    const episode = Number(params.get('vidsrc-episode') || 1);
    const title = kind === 'series' ? 'Breaking Bad — S01E01' : 'Fight Club';
    const showId = 'vidsrc-local-' + kind + '-' + tmdbId;
    let cancelled = false;

    setPlayingStreamData({
      title,
      streamUrl: '',
      all_streams: [],
      ranked_streams: [],
      showId,
      showTitle: title,
      episodeId: showId,
      episodeNumber: episode,
      episodeTitle: title,
      isLoading: true,
    });

    const query = new URLSearchParams({
      season: String(season),
      episode: String(episode),
      audio: 'es,en,ja',
      subtitles: 'es,en',
    });
    fetch(`/api/v1/providers/${kind}/${tmdbId}?${query.toString()}`)
      .then(async (response) => {
        if (!response.ok) throw new Error('VidSrc gateway HTTP ' + response.status);
        return response.json();
      })
      .then((data) => {
        const sources = Array.isArray(data?.sources)
          ? data.sources.filter((source: any) => source?.provider === 'vidsrc' && source?.streamType === 'hls' && source?.url)
          : [];
        const fallbackLocator = kind === 'movie'
          ? `https://vidsrc.me/embed/movie/${tmdbId}`
          : `https://vidsrc.me/embed/tv/${tmdbId}/${season}/${episode}`;
        // Para el arnés local preferimos el mirror que ya expone más de una
        // pista de audio. El resto de mirrors sigue disponible como fallback.
        const orderedSources = [
          ...sources.filter((candidate: any) =>
            Array.isArray(candidate.audioTracks) && candidate.audioTracks.length > 1,
          ),
          ...sources,
        ].filter((candidate: any, index: number, all: any[]) =>
          all.findIndex((entry) => entry.canonicalLocator === candidate.canonicalLocator) === index,
        );
        const fallbackSource = {
          provider: 'vidsrc',
          canonicalLocator: fallbackLocator,
          url: '',
          streamType: 'hls',
          audioLanguage: 'en',
          subtitleLanguage: null,
        };
        const sessionSources = orderedSources.length > 0 ? orderedSources : [fallbackSource];
        const source = sessionSources[0];
        const subtitleTracksForSource = (candidate: any) => Array.isArray(candidate.subtitles)
          ? candidate.subtitles.map((track: any, trackIndex: number) => ({
              id: `${candidate.provider || 'vidsrc'}-${track.id || trackIndex}`,
              label: track.label || track.language || 'Subtítulo',
              language: track.language || track.lang || 'und',
              url: track.url || track.src,
              is_default: Boolean(track.is_default || track.default),
            })).filter((track: any) => /^https?:\/\//i.test(String(track.url || '')))
          : [];
        const sessionForSource = async (candidate: any, index: number): Promise<any> => {
          const sessionResponse = await fetch('/api/v1/playback/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ original_url: candidate.canonicalLocator || candidate.url }),
          });
          if (sessionResponse.ok) {
            return {
              sources: [candidate],
              session: await sessionResponse.json(),
              sourceSubtitleTracks: subtitleTracksForSource(candidate),
            };
          }
          if (index + 1 < sessionSources.length) return sessionForSource(sessionSources[index + 1], index + 1);
          throw new Error('VidSrc proxy session HTTP ' + sessionResponse.status);
        };
        return sessionForSource(source, 0);
      })
      .then(({ sources, session, sourceSubtitleTracks }) => {
        if (cancelled) return;
        const playbackUrl = session.playback_url;
        const ranked = sources.slice(0, 1).map((source: any, index: number) => ({
          // El arnés usa la URL opaca local; el HLS firmado queda solo como
          // evidencia del resolver y nunca se expone al navegador.
          url: playbackUrl,
          type: 'direct' as const,
          tier: index,
          provider: source.provider,
          source_site: source.provider,
          original_url: source.canonicalLocator || source.url,
          canonical_locator: source.canonicalLocator || source.url,
          // La URL ya es una sesión proxy local. Sus headers del CDN se
          // aplican server-side y no deben crear un segundo proxy.
          requiredHeaders: undefined,
          is_proxyable: false,
          is_refreshable: false,
          delivery_mode: 'direct' as const,
          rating: 10,
          audio_language: source.audioLanguage || undefined,
          subtitle_language: source.subtitleLanguage || undefined,
          subtitles: sourceSubtitleTracks,
        }));
        setPlayingStreamData((previous: any) => previous
          ? {
              ...previous,
              streamUrl: ranked[0].url,
              all_streams: ranked.map((candidate: any) => candidate.url),
              // Este arnés valida el relay dentro del player sin mezclar el
              // failover de mirrors. La sesión ya es local.
              ranked_streams: ranked,
              subtitleTracks: sourceSubtitleTracks,
              isLoading: false,
            }
          : previous);
      })
      .catch((error: any) => {
        if (cancelled) return;
        setPlayingStreamData((previous: any) => previous
          ? { ...previous, loadError: error?.message || 'No se pudo resolver VidSrc', isLoading: false }
          : previous);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // Sincronizar progreso desde el servidor si el usuario está autenticado
  useEffect(() => {
    const syncProgress = async () => {
      if (isAuthenticated && user) {
        try {
          const res = await api.getProgress();
          if (Array.isArray(res?.items)) {
            setContinueWatchingItems(res.items);
            try {
              localStorage.setItem(STORAGE_CONTINUE_KEY, JSON.stringify(res.items));
            } catch {}
          }
        } catch (e) {
          console.warn('Error sincronizando progreso con servidor:', e);
        }
      }
    };
    syncProgress();
  }, [isAuthenticated, user]);

  // Cargar rieles de recomendación personalizadas del algoritmo y el Hero Pick
  const fetchRecommendations = useCallback(async () => {
    setIsLoadingRecs(true);
    try {
      const res = await api.getRecommendations();
      if (res?.hero) {
        setHeroRecommendation(res.hero);
      }
      if (Array.isArray(res?.rails)) {
        setRecommendationRails(res.rails);
      }
    } catch (e) {
      console.warn('Error cargando recomendaciones:', e);
    } finally {
      setIsLoadingRecs(false);
    }
  }, []);

  useEffect(() => {
    fetchRecommendations();
  }, [fetchRecommendations, user]);

  // Eliminar un item de "Seguir Viendo" del estado, storage y servidor
  const removeContinueWatchingItem = useCallback((episodeId: string) => {
    setContinueWatchingItems((prev) => {
      const next = prev.filter((p) => p.episodeId !== episodeId);
      try {
        localStorage.setItem(STORAGE_CONTINUE_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });

    if (isAuthenticated) {
      api.deleteProgressItem(episodeId).catch(() => {});
    }
  }, [isAuthenticated]);

  // Actualizar en sitio un item de "Seguir Viendo" (reparación de metadatos)
  const updateContinueWatchingItem = useCallback((item: WatchProgress) => {
    setContinueWatchingItems((prev) => {
      const idx = prev.findIndex((p) => p.episodeId === item.episodeId);
      if (idx === -1) return prev;
      const next = [...prev];
      next[idx] = item;
      try {
        localStorage.setItem(STORAGE_CONTINUE_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  // Fetch all genres from server API (Anime & Movies/Series APIs)
  useEffect(() => {
    const fetchGenres = async () => {
      try {
        const res = await fetch('/api/v1/genres');
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data?.genres)) {
            setAllGenresList(data.genres);
          }
        }
      } catch (e) {
        console.error('Error cargando géneros:', e);
      }
    };
    fetchGenres();
  }, []);

  // Búsqueda server-side en PostgreSQL con debounce: consulta toda la base de
  // Búsqueda server-side en PostgreSQL: consulta toda la base de
  // datos de 38,000+ obras para títulos que no entraron en el lote inicial de 25k.
  useEffect(() => {
    const query = searchQuery.trim();
    if (query.length < 2) {
      setServerSearchResults([]);
      return;
    }
    let isCancelled = false;
    const fetchServerSearch = async () => {
      try {
        const publicRes = await fetch(`/api/v1/catalog/public?kind=all&query=${encodeURIComponent(query)}&limit=100`);
        const res = publicRes.ok
          ? publicRes
          : await fetch(`/api/v1/shows?lite=true&search=${encodeURIComponent(query)}&limit=100`);
        if (res.ok && !isCancelled) {
          const data = await res.json();
          const list = Array.isArray(data) ? data : data.shows || [];
          if (Array.isArray(list)) {
            const mapped: Show[] = list.map(mapCatalogShow);
            setServerSearchResults(mapped);
          }
        }
      } catch (e) {
        console.warn('Error en búsqueda server-side:', e);
      }
    };
    fetchServerSearch();
    return () => { isCancelled = true; };
  }, [searchQuery]);

  // LIMPIEZA DE HUÉRFANOS EN "SEGUIR VIENDO" (#2/R2): tras re-scrapes, las
  // tarjetas pueden apuntar a episodios borrados (404 al reproducir) o mostrar
  // "Episodio undefined". Al cargar el catálogo se valida cada item contra la
  // API y los que ya no existen se eliminan del storage.
  const purgeOrphanContinueWatching = useCallback(
    async (catalog: Show[]) => {
      const saved = localStorage.getItem(STORAGE_CONTINUE_KEY);
      if (!saved) return;
      let items: WatchProgress[];
      try {
        items = JSON.parse(saved);
      } catch {
        return;
      }
      if (!Array.isArray(items) || items.length === 0) return;

      const catalogIds = new Set(catalog.map((s) => s.id));
      const showById = new Map(catalog.map((s) => [s.id, s]));

      // Fase 1 (síncrona): shows inexistentes o metadatos rotos
      const isBroken = (it: WatchProgress) =>
        !it?.episodeId ||
        !it?.showId ||
        !catalogIds.has(it.showId) ||
        !it.showTitle ||
        /^undefined$/i.test(String(it.showTitle)) ||
        /^Episodio undefined$/i.test(String(it.episodeTitle || ''));

      const phase1Valid: WatchProgress[] = [];
      items.forEach((it) => {
        if (isBroken(it)) {
          removeContinueWatchingItem(it.episodeId);
        } else {
          // Reparar título de episodio undefined usando el catálogo cargado
          const fixed: WatchProgress = { ...it };
          const show = showById.get(it.showId);
          if (!fixed.showTitle && show) fixed.showTitle = show.title;
          if (
            (!fixed.episodeTitle || /^undefined$/i.test(fixed.episodeTitle)) &&
            typeof fixed.episodeNumber === 'number'
          ) {
            fixed.episodeTitle = `Episodio ${fixed.episodeNumber}`;
          }
          if (fixed !== it) {
            updateContinueWatchingItem(fixed);
          }
          phase1Valid.push(fixed);
        }
      });
      if (phase1Valid.length === items.length) {
        // Nada sospechoso localmente; validar contra la API solo si hay dudas
        // sería costoso: se hace HEAD/GET por item en segundo plano.
      }

      // Fase 2 (async): validar episodeId contra la BD vía /api/v1/play (404 → huérfano)
      await Promise.all(
        phase1Valid.map(async (it) => {
          // TMDB-backed virtual episodes are resolved by the provider gateway;
          // they intentionally have no legacy `/api/v1/play` row to validate.
          if (/^tmdb-(movie|series|anime)-\d+-s\d+-e\d+$/.test(String(it.episodeId || ''))) return;
          try {
            const res = await fetch(`/api/v1/play/${encodeURIComponent(it.episodeId)}`, {
              method: 'GET',
            });
            if (res.status === 404) {
              removeContinueWatchingItem(it.episodeId);
            }
          } catch {
            // Servidor caído: no purgar por falsos negativos
          }
        })
      );
    },
    [removeContinueWatchingItem, updateContinueWatchingItem]
  );

  // 1. Cargar el catálogo UNA SOLA VEZ (lite: sin episodios, ~2MB)
  const fetchFreshCatalog = async (isBackground = false, page = 1, append = false) => {
    try {
      const publicRes = await fetch(`/api/v1/catalog/public?kind=all&mode=trending&limit=${PUBLIC_CATALOG_BATCH_SIZE}&page=${page}`);
      const res = publicRes.ok
        ? publicRes
        : await fetch('/api/v1/shows?lite=true&limit=25000');
      if (res.ok) {
        const data = await res.json();
        const list = Array.isArray(data) ? data : data.shows || [];
        if (Array.isArray(list)) {
          const safeShows: Show[] = list.map(mapCatalogShow);

          if (append) {
            // Merge by the namespaced TMDB id so loading the next public batch
            // cannot reintroduce duplicates from provider or legacy rows.
            setShows((previous) => {
              const merged = new Map(previous.map((show) => [show.id, show]));
              for (const show of safeShows) merged.set(show.id, show);
              return [...merged.values()];
            });
            setPublicCatalogPage(page);
            setHasMorePublicCatalog(safeShows.length >= PUBLIC_CATALOG_BATCH_SIZE);
            try {
              const cached = localStorage.getItem(CATALOG_CACHE_KEY);
              const cachedData = cached ? JSON.parse(cached).data : [];
              const merged = new Map< string, Show>(
                (Array.isArray(cachedData) ? cachedData : []).map((show: Show) => [show.id, show]),
              );
              for (const show of safeShows) merged.set(show.id, show);
              localStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify({ data: [...merged.values()], timestamp: Date.now() }));
            } catch {}
            return;
          }

          // Only re-render if catalog actually changed (avoids SmartImage reset)
          if (isBackground) {
            const currentIds = shows.map(s => s.id).join(',');
            const newIds = safeShows.map(s => s.id).join(',');
            if (currentIds === newIds) return;
          }

          setShows(safeShows);
          setPublicCatalogPage(page);
          setHasMorePublicCatalog(safeShows.length >= PUBLIC_CATALOG_BATCH_SIZE);

          // Save to cache
          try {
            localStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify({
              data: safeShows,
              timestamp: Date.now(),
            }));
          } catch {}
        }
      }
    } catch (e) {
      if (!isBackground) console.error('Error cargando catálogo:', e);
    }
  };

  const loadMorePublicCatalog = async () => {
    if (isLoadingMoreCatalog || !hasMorePublicCatalog) return;
    setIsLoadingMoreCatalog(true);
    try {
      // `kind=all&limit=60` consumes three TMDB pages per request. Start the
      // next batch immediately after the pages already shown.
      await fetchFreshCatalog(true, publicCatalogPage + PUBLIC_CATALOG_PAGE_STEP, true);
      setCatalogPageSize((previous) => previous + PUBLIC_CATALOG_BATCH_SIZE);
    } finally {
      setIsLoadingMoreCatalog(false);
    }
  };

  const loadCatalog = async () => {
    try {
      setIsLoading(true);

      // 1. Try cache first (instant)
      try {
        // Remove the pre-provider-cutover cache once per browser profile. The
        // old payload may contain legacy-only cards that the public API no
        // longer returns.
        localStorage.removeItem(RETIRED_CATALOG_CACHE_KEY);
        const cached = localStorage.getItem(CATALOG_CACHE_KEY);
        if (cached) {
          const { data, timestamp } = JSON.parse(cached);
          if (Date.now() - timestamp < CATALOG_CACHE_TTL && Array.isArray(data) && data.length > 0) {
            setShows(data);
            setPublicCatalogPage(1);
            setHasMorePublicCatalog(true);
            setIsLoading(false);
            // Still fetch fresh in background
            fetchFreshCatalog(true);
            return;
          }
        }
      } catch {}

      // 2. No cache or expired: fetch normally
      await fetchFreshCatalog(false);
    } catch (e) {
      console.error('Error cargando catálogo:', e);
    } finally {
      setIsLoading(false);
    }
  };

  // Cargar UNA VEZ al montar (no re-cargar en cada búsqueda)
  useEffect(() => {
    loadCatalog();
  }, []);

  // Tras cargar el catálogo, purgar las tarjetas de "Seguir Viendo" que
  // apunten a episodios/shows ya borrados (#2/R2).
  useEffect(() => {
    if (shows.length > 0) {
      void purgeOrphanContinueWatching(shows);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shows]);

  const handleOpenDetails = (show: Show) => {
    if (show?.id) {
      setSelectedShowId(show.id);
    }
  };

  const handleSelectEpisode = async (episode: Episode, showTitle: string) => {
    const showId = episode.show_id || selectedShowId || 'unknown';
    // La tarjeta de búsqueda puede proceder del lote server-side y no estar
    // todavía en `shows`; conserva sus IDs canónicos para activar gateway y
    // subtítulos (OpenSubtitles) igual que una tarjeta del catálogo principal.
    const currentShow = shows.find((s) => s.id === showId)
      || serverSearchResults.find((s) => s.id === showId);
    const existingProgress = continueWatchingItems.find(p => p.showId === showId && p.episodeId === episode.id);
    const initialTime = existingProgress?.currentTime || 0;

    // 1. Abrir el reproductor al instante para feedback visual inmediato
    setPlayingStreamData({
      title: `${showTitle} - ${safeEpisodeTitle(episode)}`,
      streamUrl: '',
      all_streams: [],
      initialTime,
      showId,
      showTitle,
      showPoster: (currentShow && thumbBackdropUrl(currentShow)) || undefined,
      episodeId: episode.id,
      episodeNumber: episode.episode_number,
      episodeTitle: safeEpisodeTitle(episode),
      isLoading: true,
    });

    // Sanear título para nunca mostrar "undefined" en el player (#2)
    const resolvedTitle = safeEpisodeTitle(episode);

    try {
      const tmdbId = Number((currentShow as any)?.tmdb_id || 0);
      const rawCategory = String((currentShow as any)?.kind || currentShow?.category || '').toLowerCase();
      const gatewayKind = rawCategory.includes('anime')
        ? 'anime'
        : (rawCategory.includes('movie') || rawCategory.includes('pel'))
          ? 'movie'
          : 'series';
      const seasonNumber = Number((episode as any).season_number || 1);
      const gatewayUrl = tmdbId > 0
        ? `/api/v1/providers/${gatewayKind}/${tmdbId}?season=${seasonNumber}&episode=${episode.episode_number}&audio=es,en,ja&subtitles=es,en`
        : null;

      const gatewayPromise = gatewayUrl
        ? fetch(gatewayUrl).then(async (response) => response.ok ? response.json() : null).catch(() => null)
        : Promise.resolve(null);
      const legacyPromise = fetch(`/api/v1/play/${episode.id}`).catch(() => null);
      const subtitleQuery = new URLSearchParams({
        tmdb_id: String(tmdbId),
        kind: gatewayKind,
        languages: 'es,en',
      });
      // Las películas no tienen temporada ni episodio. Enviarlos hace que
      // OpenSubtitles interprete la búsqueda como una serie y devuelva cero.
      if (gatewayKind !== 'movie') {
        subtitleQuery.set('season', String(seasonNumber));
        subtitleQuery.set('episode', String(episode.episode_number));
      }
      const subtitlePromise = tmdbId > 0
        ? fetch(`/api/v1/subtitles?${subtitleQuery.toString()}`)
            .then(async (response) => response.ok ? response.json() : null)
            .catch(() => null)
        : Promise.resolve(null);
      const [gatewayData, legacyResponse, subtitleData] = await Promise.all([gatewayPromise, legacyPromise, subtitlePromise]);

      // Un gateway puede devolver muchos mirrors del mismo proveedor (VidSrc
      // suele entregar una docena). Conservarlos todos hace que un host caído
      // dispare una cascada de sesiones y consuma el presupuesto del backend
      // antes de llegar a Cinecalidad/Gnula. Dejamos tres por proveedor para
      // mantener mirrors reales sin convertir un fallo en una tormenta.
      const gatewaySourceCount = new Map<string, number>();
      const gatewaySources = Array.isArray(gatewayData?.sources)
        ? gatewayData.sources.filter((source: any) => {
            const provider = String(source?.provider || 'api').toLowerCase();
            const count = gatewaySourceCount.get(provider) || 0;
            if (count >= 3) return false;
            gatewaySourceCount.set(provider, count + 1);
            return true;
          })
        : [];
      const gatewayRanked = gatewaySources.length > 0
        ? gatewaySources.map((source: any, index: number) => {
            let host: string | null = null;
            try { host = new URL(source.url).hostname.replace(/^www\./, ''); } catch {}
            return {
              url: source.url,
              type: 'direct' as const,
              tier: index,
              host,
              provider: source.provider,
              source_site: source.provider,
              original_url: source.canonicalLocator || source.url,
              canonical_locator: source.canonicalLocator || source.url,
              is_proxyable: true,
              is_refreshable: Boolean(source.canonicalLocator),
              delivery_mode: source.requiredHeaders ? 'proxy_required' as const : 'direct_trial' as const,
              requiredHeaders: source.requiredHeaders,
              rating: 10,
              link_type: source.audioLanguage ? 'audio' : undefined,
              language: source.audioLanguage || undefined,
              audio_language: source.audioLanguage || undefined,
              subtitle_language: source.subtitleLanguage || undefined,
              subtitles: Array.isArray(source.subtitles)
                ? source.subtitles
                    .map((track: any, trackIndex: number) => mapInternalSubtitleTrack(track, `${source.provider || 'api'}-${trackIndex}`))
                    .filter(Boolean)
                : [],
            };
          })
        : [];

      // El gateway mantiene los locators de plataforma separados de los
      // directos reproducibles. Son fuentes válidas para el reproductor porque
      // HLSPlayerModal las resuelve JIT mediante el adaptador especializado;
      // omitirlas aquí dejaba visible únicamente LatAnime aunque ZokoAnime
      // estuviera registrado para el mismo episodio.
      const gatewayFallbacks = Array.isArray(gatewayData?.fallbackCandidates)
        ? gatewayData.fallbackCandidates.map((source: any, index: number) => {
            let host: string | null = null;
            try { host = new URL(source.url).hostname.replace(/^www\./, ''); } catch {}
            return {
              url: source.url,
              type: 'embed' as const,
              tier: gatewayRanked.length + index,
              host,
              provider: source.provider,
              source_site: source.provider,
              canonical_locator: source.canonicalLocator || source.url,
              original_url: source.url,
              delivery_mode: 'embed' as const,
              is_refreshable: true,
              is_proxyable: false,
              requiredHeaders: undefined,
              link_type: source.type,
              language: source.audioLanguage || undefined,
              audio_language: source.audioLanguage || undefined,
              subtitle_language: source.subtitleLanguage || undefined,
              subtitles: Array.isArray(source.subtitles)
                ? source.subtitles
                    .map((track: any, trackIndex: number) => mapInternalSubtitleTrack(track, `${source.provider || 'fallback'}-${index}-${trackIndex}`))
                    .filter(Boolean)
                : [],
            };
          })
        : [];

      let legacyData: any = null;
      if (legacyResponse?.ok) legacyData = await legacyResponse.json();

      const externalSubtitles = Array.isArray(subtitleData?.tracks)
        ? subtitleData.tracks
            .map((track: any, index: number) => mapInternalSubtitleTrack(track, String(track.id || `opensubtitles-${index}`)))
            .filter(Boolean)
        : [];

      const mergedRanked: any[] = [];
      const seenUrls = new Set<string>();
      for (const candidate of [
        ...gatewayRanked,
        ...gatewayFallbacks,
        ...(Array.isArray(legacyData?.ranked_streams) ? legacyData.ranked_streams : []),
      ]) {
        if (!candidate?.url || seenUrls.has(candidate.url)) continue;
        seenUrls.add(candidate.url);
        mergedRanked.push(candidate);
      }

      const mergedStreams = mergedRanked.map((candidate) => candidate.url);
      const primaryStream = mergedStreams[0] || legacyData?.stream_url || '';

      if (!primaryStream) {
        if (legacyResponse?.status === 404) {
          removeContinueWatchingItem(episode.id);
          setPlayingStreamData((prev: any) =>
            prev?.episodeId === episode.id ? null : prev
          );
          setOrphanNotice(
            `"${showTitle} — ${resolvedTitle}" ya no está disponible en el catálogo y fue eliminado de Seguir Viendo.`
          );
          return;
        }
        throw new Error('No se encontró un stream directo ni un fallback reproducible');
      }

      setPlayingStreamData((prev: any) => {
        if (!prev || prev.episodeId !== episode.id) return prev;
        return {
          ...prev,
          title: `${showTitle} - ${resolvedTitle}`,
          streamUrl: primaryStream,
          all_streams: mergedStreams.length > 0 ? mergedStreams : [primaryStream],
          ranked_streams: mergedRanked,
          subtitleTracks: externalSubtitles,
          isLoading: false,
        };
      });
    } catch (e: any) {
      setPlayingStreamData((prev: any) => {
        if (!prev || prev.episodeId !== episode.id) return prev;
        return {
          ...prev,
          loadError: e.message || 'Error al iniciar la reproducción',
          isLoading: false,
        };
      });
    }
  };

  // Conteo de shows por género para el modal
  const showsCountByGenre = useMemo(() => {
    const counts: Record<string, number> = {};
    shows.forEach((s) => {
      const genresStr = Array.isArray(s.genres) ? s.genres.join(', ') : String(s.genres || '');
      genresStr.split(',').forEach((g) => {
        const key = g.trim().toLowerCase();
        if (key) {
          counts[key] = (counts[key] || 0) + 1;
        }
      });
    });
    return counts;
  }, [shows]);

  // Filtrado suave de catálogo por categorías y géneros
  const filteredShows = useMemo(() => {
    let result = shows;

    // Si hay búsqueda activa, priorizar resultados server-side (PostgreSQL ts_rank sobre las 38,000+ obras)
    if (searchQuery && searchQuery.trim().length >= 2) {
      const qNorm = normalizeText(searchQuery);
      const serverIds = new Set(serverSearchResults.map((s) => s.id));
      const localMatches = shows.filter((s) => {
        if (serverIds.has(s.id)) return false;
        const t = normalizeText(s.title || '');
        const e = normalizeText(s.english_title || '');
        const o = normalizeText(s.original_title || '');
        return t.includes(qNorm) || e.includes(qNorm) || o.includes(qNorm);
      });
      // Public TMDB search can return a related movie before the exact local
      // anime/series title (for example, a franchise film before SPY x FAMILY).
      // Apply the same title relevance scoring to the merged list so an exact
      // match always opens first and does not look like a duplicate mismatch.
      result = searchShows([...serverSearchResults, ...localMatches], searchQuery);
    } else {
      // Filtro por categoría únicamente cuando no hay búsqueda activa
      if (activeFilter !== 'all') {
        const filterKey = activeFilter.toLowerCase();
        result = result.filter((s) => {
          const cat = (s.category || '').toLowerCase();
          const title = (s.title || '').toLowerCase();
          const genresStr = Array.isArray(s.genres) ? s.genres.join(' ').toLowerCase() : String(s.genres || '').toLowerCase();

          if (filterKey === 'anime') return cat === 'anime' || (cat !== 'movie' && cat !== 'series' && genresStr.includes('anime'));
          if (filterKey === 'movie') return cat.includes('pel') || cat.includes('movie');
          if (filterKey === 'series') return cat.includes('serie') || cat.includes('tv');
          if (filterKey === 'terror') return genresStr.includes('terror') || genresStr.includes('horror');
          if (filterKey === 'horror') return genresStr.includes('terror') || genresStr.includes('horror');
          if (filterKey === 'acción' || filterKey === 'accion') return genresStr.includes('acci') || genresStr.includes('action');
          if (filterKey === 'fantasía' || filterKey === 'fantasia') return genresStr.includes('fantas') || genresStr.includes('fantasy');
          if (filterKey === 'ciencia ficción' || filterKey === 'sci-fi' || filterKey === 'scifi') return genresStr.includes('sci-fi') || genresStr.includes('ciencia') || genresStr.includes('futuro');
          if (filterKey === 'suspenso') return genresStr.includes('suspen') || genresStr.includes('thriller');
          if (filterKey === 'shounen' || filterKey === 'shonen') return genresStr.includes('shounen') || genresStr.includes('shonen') || title.includes('piece') || title.includes('naruto') || title.includes('dragon');
          if (filterKey === 'seinen') return genresStr.includes('seinen') || genresStr.includes('psicológico') || genresStr.includes('drama');
          if (filterKey === 'romance') return genresStr.includes('romance') || genresStr.includes('amor');
          return genresStr.includes(filterKey) || cat.includes(filterKey) || title.includes(filterKey);
        });
      }
    }

    // Filtro por año
    if (yearFilter !== null) {
      result = result.filter((s) => Number(s.year) === yearFilter);
    }

    // Orden (recientes = orden de ingesta tal cual llega)
    if (sortBy !== 'recientes') {
      const sorted = [...result];
      if (sortBy === 'rating') sorted.sort((a, b) => (b.rating || 0) - (a.rating || 0));
      else if (sortBy === 'anio') sorted.sort((a, b) => (Number(b.year) || 0) - (Number(a.year) || 0));
      else if (sortBy === 'az') sorted.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'es'));
      result = sorted;
    }

    return result;
  }, [shows, serverSearchResults, activeFilter, searchQuery, yearFilter, sortBy]);

  // Años disponibles para el filtro (de más nuevo a más viejo)
  const availableYears = useMemo(() => {
    const set = new Set<number>();
    for (const s of shows) {
      const y = Number(s.year);
      if (y >= 1940 && y <= new Date().getFullYear() + 1) set.add(y);
    }
    return [...set].sort((a, b) => b - a);
  }, [shows]);

  // Secciones divididas para la pantalla de inicio
  const topRatedShows = useMemo(
    () => [...shows].sort((a, b) => (b.rating || 0) - (a.rating || 0)).slice(0, 10),
    [shows]
  );

  // Filas por GÉNERO: los géneros más comunes del catálogo, cada uno ordenado
  // por rating. Reemplaza las viejas filas "por recencia" (anime/internacional).
  const genreRows = useMemo(() => {
    if (shows.length === 0) return [];
    const toList = (g: unknown): string[] =>
      Array.isArray(g) ? g.map(String) : String(g || '').split(',');
    const counts = new Map<string, number>();
    for (const s of shows) {
      for (const g of toList(s.genres)) {
        const clean = g.trim();
        if (!clean) continue;
        const low = clean.toLowerCase();
        if (low === 'multimedia' || low === 'anime' || low === 'película' || low === 'serie') continue;
        counts.set(clean, (counts.get(clean) || 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([genre]) => ({
        genre,
        items: shows
          .filter((s) => toList(s.genres).map((x) => x.trim()).includes(genre))
          .sort((a, b) => (b.rating || 0) - (a.rating || 0))
          .slice(0, 40),
      }))
      .filter((r) => r.items.length >= 8);
  }, [shows]);



  // SELECCIÓN INTELIGENTE DEL HERO BANNER (Máxima Calidad Visual + Máxima Afinidad)
  const featuredShow = useMemo(() => {
    if (shows.length === 0) return null;

    // 1. Si el servidor nos dio un Hero Pick personalizado con buena imagen, usarlo
    if (heroRecommendation) {
      const matchInCatalog = shows.find((s) => s.id === heroRecommendation.id);
      const target = matchInCatalog || heroRecommendation;
      const hasVisuals = Boolean((target as any).backdrop_path || (target as any).banner_url || target.poster_url);
      if (hasVisuals) {
        return target;
      }
    }

    // 2. Extraer afinidad de géneros basada en el historial del usuario
    const genreScore: Record<string, number> = {};
    const watchedIds = new Set(continueWatchingItems.map((i) => i.showId));

    continueWatchingItems.forEach((it, idx) => {
      const show = shows.find((s) => s.id === it.showId);
      if (show && show.genres) {
        const weight = Math.max(1, 5 - idx);
        const list = Array.isArray(show.genres) ? show.genres : String(show.genres).split(/[,/|•]+/);
        list.forEach((g) => {
          const clean = g.trim().toLowerCase();
          if (clean && !/multimedia|general/i.test(clean)) {
            genreScore[clean] = (genreScore[clean] || 0) + weight;
          }
        });
      }
    });

    const topGenres = Object.entries(genreScore)
      .sort((a, b) => b[1] - a[1])
      .map(([g]) => g);

    // 3. Puntuar cada obra para elegir la opción definitiva con backdrop épico
    let bestShow: Show | null = null;
    let bestScore = -Infinity;

    for (const s of shows) {
      let score = 0;

      // A. Calidad visual de backdrop / poster
      const hasBackdrop = Boolean((s as any).backdrop_path && (s as any).backdrop_path.startsWith('/'));
      const hasBanner = Boolean((s as any).banner_url && (s as any).banner_url.startsWith('http'));
      const hasPoster = Boolean((s as any).poster_path || (s.poster_url && s.poster_url.startsWith('http')));

      if (!hasBackdrop && !hasBanner && !hasPoster) continue;

      if (hasBackdrop) score += 90; // Backdrop TMDB panorámico en alta definición
      else if (hasBanner) score += 65; // Banner oficial
      else if (hasPoster) score += 25;

      if (s.poster_url && /unsplash|placeholder|default/i.test(s.poster_url)) {
        score -= 120;
      }

      // B. Calidad de sinopsis
      if (s.description && s.description.length > 70 && !/contenido indexado en/i.test(s.description)) {
        score += 40;
      } else if (s.description && s.description.length > 25) {
        score += 15;
      }

      // C. Valoración de la crítica (Rating)
      const rating = typeof s.rating === 'number' ? s.rating : 7.0;
      score += rating * 12; // 8.5 -> +102 pts

      // D. Afinidad de géneros
      if (topGenres.length > 0) {
        const genresStr = Array.isArray(s.genres) ? s.genres.join(' ').toLowerCase() : String(s.genres || '').toLowerCase();
        topGenres.forEach((g, idx) => {
          if (genresStr.includes(g)) {
            score += Math.max(15, 60 - idx * 15);
          }
        });
      }

      // E. Si ya fue visto completamente, aplicar leve penalización para favorecer el descubrimiento
      if (watchedIds.has(s.id)) {
        score -= 30;
      }

      if (score > bestScore) {
        bestScore = score;
        bestShow = s;
      }
    }

    return bestShow || shows[0] || null;
  }, [shows, heroRecommendation, continueWatchingItems]);

  return (
    <div className="app-shell relative min-h-screen text-zinc-100 flex flex-col">
      {/* 1. DYNAMIC AMBIENT GLOW (RESPONDE AL COLOR DOMINANTE DEL CONTENIDO EN FOCO) */}
      <a className="skip-link" href="#main-content">Ir al contenido</a>

      {/* HEADER UNIFICADO: LOGO, BUSCADOR Y CATEGORÍAS EN LA MISMA BARRA SUPERIOR */}
      <UnifiedHeader
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        activeFilter={activeFilter}
        onSelectCategory={(f) => { setActiveFilter(f); setGridPageSize(100); }}
      />

      <main id="main-content" tabIndex={-1} className="relative z-10 flex-1 pb-24">
        {/* AVISO DE CONTENIDO HUÉRFANO ELIMINADO DE "SEGUIR VIENDO" (#2/R2) */}
        {orphanNotice && (
          <div className="max-w-7xl mx-auto px-4 sm:px-8 pt-4">
            <div className="mx-auto max-w-2xl rounded-xl border border-zinc-700/70 bg-zinc-900/90 px-4 py-3 text-xs text-zinc-300 shadow-lg backdrop-blur-md flex items-start justify-between gap-3 animate-in fade-in slide-in-from-top-2 duration-200">
              <span>{orphanNotice}</span>
              <button
                type="button"
                onClick={() => setOrphanNotice(null)}
                aria-label="Descartar aviso"
                className="shrink-0 text-zinc-500 hover:text-white transition-colors"
              >
                ✕
              </button>
            </div>
          </div>
        )}
        {(shows.length > 0 || serverSearchResults.length > 0) ? (
          <>
            {/* HERO BANNER PRINCIPAL (70% VH, KEN BURNS, PILL BUTTONS) */}
            {featuredShow && !searchQuery && activeFilter === 'all' && (
              <HeroBanner
                media={featuredShow}
                onPlay={() => handleOpenDetails(featuredShow)}
                onMoreInfo={() => handleOpenDetails(featuredShow)}
              />
            )}

            <div className="catalog-content space-y-12">

              {/* CASO 0: SI HAY BÚSQUEDA ACTIVA, MOSTRAR RESULTADOS (TIENE PRIORIDAD SOBRE CUALQUIER PESTAÑA O VISTA) */}
              {searchQuery && searchQuery.trim().length >= 2 ? (
                <section className="space-y-4">
                  <div className="flex items-center justify-between border-b border-zinc-800/80 pb-3">
                    <h3 className="font-display text-xl sm:text-2xl font-bold text-white tracking-tight">
                      Resultados para "{searchQuery}"
                    </h3>
                    <span className="font-mono text-xs text-zinc-500">
                      {filteredShows.length} {filteredShows.length === 1 ? 'obra' : 'obras'}
                    </span>
                  </div>

                  <CatalogFilters
                    years={availableYears}
                    year={yearFilter}
                    onYear={(y) => { setYearFilter(y); setGridPageSize(100); }}
                    sort={sortBy}
                    onSort={(s) => { setSortBy(s); setGridPageSize(100); }}
                  />

                  {filteredShows.length === 0 ? (
                    <div className="py-20 text-center space-y-3">
                      <Film size={36} className="mx-auto text-zinc-600" />
                      <p className="text-sm text-zinc-400 font-medium">
                        No se encontraron títulos para este criterio.
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          setSearchQuery('');
                          setActiveFilter('all');
                          setGridPageSize(100);
                        }}
                        className="text-xs text-amber-400 hover:underline font-semibold"
                      >
                        Restablecer filtros
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 sm:gap-5">
                        {filteredShows.slice(0, gridPageSize).map((item) => (
                          <MediaCard
                            key={item.id}
                            media={item}
                            onSelectMedia={handleOpenDetails}
                          />
                        ))}
                      </div>
                      {filteredShows.length > gridPageSize && (
                        <div className="flex justify-center pt-6">
                          <button
                            type="button"
                            onClick={() => setGridPageSize(prev => prev + 100)}
                            className="px-6 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-sm font-medium text-zinc-200 border border-zinc-700 transition-colors"
                          >
                            Cargar más ({filteredShows.length - gridPageSize} restantes)
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </section>
              ) : activeFilter === 'recommendations' ? (
                <section className="space-y-10">
                  <div className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-800/80 pb-4">
                    <div>
                      <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-400 text-xs font-semibold mb-2">
                        <Sparkles size={13} />
                        <span>Selección MeriStream</span>
                      </div>
                      <h3 className="font-display text-2xl sm:text-3xl font-bold text-white tracking-tight">
                        {isAuthenticated && user ? `Recomendaciones para ${user.username}` : 'Recomendaciones y Tendencias'}
                      </h3>
                      <p className="text-xs sm:text-sm text-zinc-400 mt-1">
                        {isAuthenticated
                          ? 'Historias elegidas a partir de lo que ves.'
                          : 'Inicia sesión para descubrir recomendaciones según tus gustos.'}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={fetchRecommendations}
                      className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-xs font-medium text-zinc-300 border border-zinc-800 transition shadow-sm hover:border-zinc-700"
                    >
                      <RefreshCw size={13} className={isLoadingRecs ? 'animate-spin text-amber-400' : ''} />
                      <span>Actualizar Recomendaciones</span>
                    </button>
                  </div>

                  {/* RIELES DE RECOMENDACIÓN GENERADOS POR EL ALGORITMO */}
                  {recommendationRails.map((rail) => (
                    <MediaRow
                      key={rail.id}
                      title={rail.title}
                      subtitle={rail.subtitle}
                      items={rail.shows}
                      onSelectMedia={handleOpenDetails}
                      isLoading={isLoadingRecs}
                    />
                  ))}

                  {recommendationRails.length === 0 && !isLoadingRecs && (
                    <div className="py-16 text-center space-y-3">
                      <Sparkles size={36} className="mx-auto text-amber-400/50" />
                      <p className="text-sm text-zinc-400 font-medium">
                        Mira tu primer título para descubrir recomendaciones para ti.
                      </p>
                    </div>
                  )}
                </section>
              ) : activeFilter === 'explore' ? (
                /* CASO B2: VISTA EXPLORAR CATÁLOGO COMPLETO — FILTROS DE GÉNERO + AÑO */
                <ExploreCatalogView
                  shows={shows}
                  allGenresList={allGenresList}
                  showsCountByGenre={showsCountByGenre}
                  genreFilter={exploreGenreFilter}
                  onGenreFilter={setExploreGenreFilter}
                  yearFilter={yearFilter}
                  onYearFilter={(y) => { setYearFilter(y); setCatalogPageSize(100); }}
                  sortBy={sortBy}
                  onSortBy={(s) => { setSortBy(s); setCatalogPageSize(100); }}
                  catalogPageSize={catalogPageSize}
                  onLoadMore={loadMorePublicCatalog}
                  hasMore={hasMorePublicCatalog}
                  isLoadingMore={isLoadingMoreCatalog}
                  availableYears={availableYears}
                  onSelectMedia={handleOpenDetails}
                />
              ) : activeFilter !== 'all' ? (
                <section className="space-y-4">
                  <div className="flex items-center justify-between border-b border-zinc-800/80 pb-3">
                    <h3 className="font-display text-xl sm:text-2xl font-bold text-white tracking-tight">
                      {({ movie: 'Películas', series: 'Series', anime: 'Anime' } as Record<string, string>)[activeFilter] || activeFilter}
                    </h3>
                    <span className="font-mono text-xs text-zinc-500">
                      {filteredShows.length} {filteredShows.length === 1 ? 'obra' : 'obras'}
                    </span>
                  </div>

                  <CatalogFilters
                    years={availableYears}
                    year={yearFilter}
                    onYear={(y) => { setYearFilter(y); setGridPageSize(100); }}
                    sort={sortBy}
                    onSort={(s) => { setSortBy(s); setGridPageSize(100); }}
                  />

                  {filteredShows.length === 0 ? (
                    <div className="py-20 text-center space-y-3">
                      <Film size={36} className="mx-auto text-zinc-600" />
                      <p className="text-sm text-zinc-400 font-medium">
                        No se encontraron títulos para este criterio.
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          setSearchQuery('');
                          setActiveFilter('all');
                          setGridPageSize(100);
                        }}
                        className="text-xs text-amber-400 hover:underline font-semibold"
                      >
                        Restablecer filtros
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 sm:gap-5">
                        {filteredShows.slice(0, gridPageSize).map((item) => (
                          <MediaCard
                            key={item.id}
                            media={item}
                            onSelectMedia={handleOpenDetails}
                          />
                        ))}
                      </div>
                      {filteredShows.length > gridPageSize && (
                        <div className="flex justify-center pt-6">
                          <button
                            type="button"
                            onClick={() => setGridPageSize(prev => prev + 100)}
                            className="px-6 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-sm font-medium text-zinc-200 border border-zinc-700 transition-colors"
                          >
                            Cargar más ({filteredShows.length - gridPageSize} restantes)
                          </button>
                        </div>
                      )}
                    </>
                  )}
                </section>
              ) : (
                /* CASO C: VISTA PRINCIPAL CON ESTRUCTURA DIVERSIFICADA (SEGUIR VIENDO + RECOMENDACIONES + BENTO BOX + FILAS) */
                <>
                  {/* SECCIÓN SEGUIR VIENDO (TARJETAS 16:9 HORIZONTALES CON BARRA DE 4PX) */}
                  {continueWatchingItems.length > 0 && (
                    <ContinueWatching
                      items={continueWatchingItems}
                      shows={shows}
                      onPlayEpisode={(_showId, ep, title) => handleSelectEpisode(ep, title)}
                      onSelectShow={(showId) => {
                        const target = shows.find((s) => s.id === showId);
                        if (target) handleOpenDetails(target);
                      }}
                      onRemoveItem={(epId) => removeContinueWatchingItem(epId)}
                    />
                  )}

                  {/* RIELES DE RECOMENDACIÓN PERSONALIZADA INTELIGENTE */}
                  {recommendationRails.slice(0, 2).map((rail) => (
                    <MediaRow
                      key={rail.id}
                      title={rail.title}
                      subtitle={rail.subtitle}
                      items={rail.shows}
                      onSelectMedia={handleOpenDetails}
                      isLoading={isLoadingRecs}
                    />
                  ))}

                  {/* RECÉN AGREGADOS (por fecha de ingesta, lo más nuevo primero) */}
                  <MediaRow
                    title="Recién agregados"
                    items={shows.slice(0, 50)}
                    onSelectMedia={handleOpenDetails}
                    isLoading={isLoading}
                  />

                  {/* CUADRÍCULA ASIMÉTRICA BENTO BOX */}
                  {topRatedShows.length >= 3 && (
                    <BentoCollection
                      title="Destacados por la crítica"
                      items={topRatedShows}
                      onSelectMedia={handleOpenDetails}
                    />
                  )}

                  {/* RIELES DE RECOMENDACIÓN RESTANTES (ej. Descubrimientos o Género Favorito) */}
                  {recommendationRails.slice(2).map((rail) => (
                    <MediaRow
                      key={rail.id}
                      title={rail.title}
                      subtitle={rail.subtitle}
                      items={rail.shows}
                      onSelectMedia={handleOpenDetails}
                      isLoading={isLoadingRecs}
                    />
                  ))}

                  {/* FILAS POR GÉNERO (ordenadas por rating dentro de cada una) */}
                  {genreRows.map((row) => (
                    <MediaRow
                      key={row.genre}
                      title={row.genre}
                      items={row.items}
                      onSelectMedia={handleOpenDetails}
                      isLoading={isLoading}
                    />
                  ))}

                  {/* EXPLORAR CATÁLOGO COMPLETO (filtros de año + orden + grid paginado) */}
                  <section className="space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800/80 pb-3">
                      <h3 className="font-display text-xl sm:text-2xl font-bold text-white tracking-tight">
                        Explorar Catálogo
                      </h3>
                      <span className="font-mono text-xs text-zinc-500">
                        {filteredShows.length} {filteredShows.length === 1 ? 'obra' : 'obras'}
                      </span>
                    </div>
                    <CatalogFilters
                      years={availableYears}
                      year={yearFilter}
                      onYear={(y) => { setYearFilter(y); setCatalogPageSize(100); }}
                      sort={sortBy}
                      onSort={(s) => { setSortBy(s); setCatalogPageSize(100); }}
                    />
                    {filteredShows.length === 0 ? (
                      <div className="py-12 text-center text-sm text-zinc-500">
                        No hay obras con estos filtros.
                      </div>
                    ) : (
                      <>
                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 sm:gap-5">
                          {filteredShows.slice(0, catalogPageSize).map((item) => (
                            <MediaCard
                              key={item.id}
                              media={item}
                              onSelectMedia={handleOpenDetails}
                            />
                          ))}
                        </div>
                        {filteredShows.length > catalogPageSize && (
                          <div className="flex justify-center pt-4">
                            <button
                              type="button"
                              onClick={() => setCatalogPageSize((prev) => prev + 100)}
                              className="px-6 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-sm font-medium text-zinc-200 border border-zinc-700 transition-colors"
                            >
                              Cargar más ({filteredShows.length - catalogPageSize} restantes)
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </section>
                </>
              )}
            </div>
          </>
        ) : (
          /* BIENVENIDA SI NO HAY TÍTULOS */
          !isLoading && (
            <div className="max-w-2xl mx-auto px-4 py-20 text-center space-y-8 animate-in fade-in duration-300">
              <div className="relative mx-auto w-20 h-20 flex items-center justify-center rounded-2xl bg-zinc-900 text-amber-400 border border-zinc-800 shadow-xl">
                <Film size={36} className="stroke-[1.6]" />
              </div>

              <div className="space-y-2.5">
                <h2 className="font-display text-2xl sm:text-3xl font-extrabold text-white tracking-tight">
                  Videoteca Personal
                </h2>
                <p className="text-sm text-zinc-400 max-w-lg mx-auto leading-relaxed">
                  Tu base de datos está lista. Puedes importar cualquier serie o anime individual o iniciar un rastreo completo desde el panel de control.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 max-w-lg mx-auto text-left">
                <button
                  type="button"
                  onClick={() => {
                    window.location.href = '/admin';
                  }}
                  className="p-4 rounded-xl bg-zinc-900 border border-zinc-800 hover:border-zinc-700 transition-all group shadow-sm"
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="flex items-center gap-1.5 text-xs font-bold text-white group-hover:text-amber-400 transition-colors">
                      <Film size={15} className="text-amber-400" />
                      Importador Rápido
                    </span>
                    <ArrowUpRight size={14} className="text-zinc-500 group-hover:text-amber-400 transition-transform" />
                  </div>
                  <p className="text-[11px] text-zinc-400">
                    Ingresa el enlace de cualquier título para extraer episodios y servidores.
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    window.location.href = '/admin';
                  }}
                  className="p-4 rounded-xl bg-zinc-900 border border-zinc-800 hover:border-zinc-700 transition-all group shadow-sm"
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="flex items-center gap-1.5 text-xs font-bold text-white group-hover:text-amber-400 transition-colors">
                      <Tv size={15} className="text-amber-400" />
                      Rastreador de Catálogo
                    </span>
                    <ArrowUpRight size={14} className="text-zinc-500 group-hover:text-amber-400 transition-transform" />
                  </div>
                  <p className="text-[11px] text-zinc-400">
                    Descarga catálogos enteros en segundo plano con control de cola.
                  </p>
                </button>
              </div>

              <div className="pt-2">
                <button
                  type="button"
                  onClick={loadCatalog}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 text-xs font-medium border border-zinc-800 transition-colors"
                >
                  <RefreshCw size={13} />
                  Comprobar títulos
                </button>
              </div>
            </div>
          )
        )}
      </main>
      <footer className="site-footer"><span className="footer-brand">meristream.</span><span>Cine, series y anime. A tu ritmo.</span></footer>

      {/* 3. VISTA DE DETALLES (DRAWER / PANEL LATERAL FLOTANTE QUE SE DESLIZA DESDE LA DERECHA) */}
      <MediaDetailsModal
        showId={selectedShowId}
        isOpen={Boolean(selectedShowId)}
        onClose={() => setSelectedShowId(null)}
        onSelectEpisode={(ep, title) => handleSelectEpisode(ep, title)}
        watchProgress={continueWatchingItems}
      />

      {/* REPRODUCTOR HLS Y PROXY DE VIDEO JUST-IN-TIME */}
      {playingStreamData && (
        <HLSPlayerModal
          isOpen={Boolean(playingStreamData)}
          onClose={() => setPlayingStreamData(null)}
          title={playingStreamData.title}
          streamUrl={playingStreamData.streamUrl}
          all_streams={playingStreamData.all_streams}
          ranked_streams={playingStreamData.ranked_streams}
          subtitleTracks={playingStreamData.subtitleTracks}
          initialTime={playingStreamData.initialTime}
          isLoading={playingStreamData.isLoading}
          loadError={playingStreamData.loadError}
          onNextEpisode={() => {
            const currentShow = shows.find((show) => show.id === playingStreamData.showId);
            const episodes = [...(currentShow?.episodes || [])]
              .filter((episode) => Number.isFinite(Number(episode.episode_number)))
              .sort((a, b) => Number(a.episode_number) - Number(b.episode_number));
            const currentIndex = episodes.findIndex((episode) => episode.id === playingStreamData.episodeId);
            const nextEpisode = currentIndex >= 0 ? episodes[currentIndex + 1] : undefined;
            if (nextEpisode && currentShow) {
              void handleSelectEpisode(nextEpisode, currentShow.title);
            } else {
              setPlayingStreamData(null);
            }
          }}
          onProgressUpdate={(currentTime, duration) => {
            if (duration > 0 && currentTime > 0) {
              const progressPercent = Math.round((currentTime / duration) * 100);

              const newProgress: WatchProgress = {
                showId: playingStreamData.showId,
                showTitle: playingStreamData.showTitle,
                showPoster: playingStreamData.showPoster,
                episodeId: playingStreamData.episodeId,
                episodeNumber: playingStreamData.episodeNumber,
                episodeTitle: playingStreamData.episodeTitle,
                progressPercent,
                currentTime,
                duration,
                lastWatchedAt: Date.now(),
              };

              setContinueWatchingItems((prev) => {
                const filtered = prev.filter((p) => p.episodeId !== playingStreamData.episodeId);
                const updated = [newProgress, ...filtered].slice(0, 50);
                try {
                  localStorage.setItem(STORAGE_CONTINUE_KEY, JSON.stringify(updated));
                } catch {}
                return updated;
              });

              // Guardar en base de datos para sincronización y algoritmo de recomendación
              if (isAuthenticated) {
                api.saveProgress({
                  showId: playingStreamData.showId,
                  showTitle: playingStreamData.showTitle,
                  showPoster: playingStreamData.showPoster,
                  episodeId: playingStreamData.episodeId,
                  episodeNumber: playingStreamData.episodeNumber,
                  episodeTitle: playingStreamData.episodeTitle,
                  progressPercent,
                  currentTime,
                  duration,
                }).catch((err) => {
                  console.warn('Error guardando progreso en servidor:', err);
                });
              }
            }
          }}
        />
      )}

      {/* MODAL DE AUTENTICACIÓN / REGISTRO / LOGIN */}
      <AuthModal />

      {/* PANEL DE ADMINISTRACIÓN, INGESTA Y WORKERS */}
      <AdminPanel
        isOpen={isAdminOpen}
        onClose={() => {
          setIsAdminOpen(false);
          loadCatalog();
        }}
        onPlayDirect={(streamResult: any) => {
          const candidates: string[] = (
            streamResult.all_streams ||
            streamResult.all_available_streams ||
            (streamResult.stream_url ? [streamResult.stream_url] : [])
          ).filter(Boolean);
          // Playable = medio directo (.m3u8/.mpd/.mp4/...) o locator conocido;
          // lo demás son páginas web crudas que requieren resolución JIT.
          const isPlayable = (u: string) =>
            /\.(m3u8|mpd|mp4|webm|mkv)(\?|#|$)/i.test(u) || isEmbedUrl(u);
          const playableCandidates = candidates.filter(isPlayable);

          if (playableCandidates.length === 0 && streamResult.stream_url) {
            // Página de episodio sin servidores resueltos (ej. AnimeFLV /ver/...):
            // resolver Just-In-Time contra el backend antes de abrir el player.
            setPlayingStreamData({
              title: streamResult.title,
              streamUrl: '',
              all_streams: [],
              isLoading: true,
            });
            api
              .getEpisodeServers(streamResult.stream_url)
              .then((data) => {
                const streams = data.all_available_streams.filter(isPlayable);
                if (streams.length === 0) throw new Error('El episodio no tiene servidores disponibles.');
                setPlayingStreamData((prev: any) =>
                  prev
                    ? { ...prev, streamUrl: streams[0], all_streams: streams, isLoading: false }
                    : prev
                );
              })
              .catch((e: any) => {
                setPlayingStreamData((prev: any) =>
                  prev
                    ? {
                        ...prev,
                        loadError: e.message || 'No se pudo resolver el video del episodio.',
                        isLoading: false,
                      }
                    : prev
                );
              });
            return;
          }

          setPlayingStreamData({
            title: streamResult.title,
            streamUrl:
              playableCandidates[0] || streamResult.stream_url,
            all_streams:
              playableCandidates.length > 0 ? playableCandidates : candidates,
          });
        }}
      />
    </div>
  );
}

export default App;
