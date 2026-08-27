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
import { AmbientGlow } from './components/AmbientGlow';
import { ContinueWatching, type WatchProgress } from './components/ContinueWatching';
import { BentoCollection } from './components/BentoCollection';
import { AuthModal } from './components/AuthModal';
import { ExploreCatalogView } from './components/ExploreCatalogView';
import { useAuth } from './contexts/AuthContext';
import { extractDominantColor, getFallbackColor } from './utils/colorExtractor';
import { thumbBackdropUrl } from './utils/imageSizes';
import { isEmbedUrl } from './utils/streamOptimizer';
import { api } from './api/client';
import { searchShows } from './utils/searchUtils';
import { RefreshCw, Film, Tv, ArrowUpRight, Sparkles } from 'lucide-react';
import type { Show, Episode } from './types';

const STORAGE_CONTINUE_KEY = 'nitiflix_continue_watching_v1';
const CATALOG_CACHE_KEY = 'nitiflix_catalog_cache_v1';
const CATALOG_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/** Nunca renderizar "Episodio undefined" (#2): fallback al número de episodio. */
function safeEpisodeTitle(episode: { title?: string; episode_number?: number }): string {
  const t = (episode.title || '').trim();
  if (t && !/^undefined$/i.test(t) && !/^null$/i.test(t)) return t;
  return episode.episode_number != null
    ? `Episodio ${episode.episode_number}`
    : 'Episodio';
}

export function App() {
  const { user, isAuthenticated } = useAuth();
  const [shows, setShows] = useState<Show[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<string>('all');
  const [gridPageSize, setGridPageSize] = useState(100);
  const [yearFilter, setYearFilter] = useState<number | null>(null);
  const [sortBy, setSortBy] = useState<SortMode>('recientes');
  const [catalogPageSize, setCatalogPageSize] = useState(100);
  const [allGenresList, setAllGenresList] = useState<string[]>([]);
  const [exploreGenreFilter, setExploreGenreFilter] = useState<string | null>(null);

  // Ambient Glow State
  const [ambientRgb, setAmbientRgb] = useState<[number, number, number]>([245, 158, 11]);

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
  const fetchFreshCatalog = async (isBackground = false) => {
    try {
      const res = await fetch('/api/v1/shows?lite=true&limit=25000');
      if (res.ok) {
        const data = await res.json();
        const list = Array.isArray(data) ? data : data.shows || [];
        if (Array.isArray(list)) {
          const safeShows: Show[] = list.map((s: any) => ({
            id: s.id || `show-${Math.random()}`,
            title: s.title || 'Sin Título',
            description: s.description || s.synopsis || '',
            synopsis: s.description || s.synopsis || '',
            poster_url: s.poster_url || '',
            banner_url: s.banner_url || s.poster_url || '',
            backdrop_url: s.backdrop_url || s.banner_url || '',
            poster_path: s.poster_path ?? null,
            backdrop_path: s.backdrop_path ?? null,
            category: s.category || 'anime',
            rating: s.rating || 8.2,
            year: s.year || 2024,
            genres: s.genres || ['Anime'],
            episode_count: s._count?.episodes || 0,
            sources: {
              master_m3u8: `/api/v1/media/${s.id}/stream`,
              fallback_mp4: null,
              qualities: [],
              subtitles: [],
            },
          }) as Show);

          // Only re-render if catalog actually changed (avoids SmartImage reset)
          if (isBackground) {
            const currentIds = shows.map(s => s.id).join(',');
            const newIds = safeShows.map(s => s.id).join(',');
            if (currentIds === newIds) return;
          }

          setShows(safeShows);

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

  const loadCatalog = async () => {
    try {
      setIsLoading(true);

      // 1. Try cache first (instant)
      try {
        const cached = localStorage.getItem(CATALOG_CACHE_KEY);
        if (cached) {
          const { data, timestamp } = JSON.parse(cached);
          if (Date.now() - timestamp < CATALOG_CACHE_TTL && Array.isArray(data) && data.length > 0) {
            setShows(data);
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
      const img = show.poster_url || show.banner_url;
      if (img) {
        extractDominantColor(img, show.title).then(setAmbientRgb);
      }
    }
  };

  const handleHoverMedia = (show: Show | null) => {
    if (show) setAmbientRgb(getFallbackColor(show.title));
  };

  const handleSelectEpisode = async (episode: Episode, showTitle: string) => {
    const showId = episode.show_id || selectedShowId || 'unknown';
    const currentShow = shows.find((s) => s.id === showId);
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
      const res = await fetch(`/api/v1/play/${episode.id}`);
      if (res.status === 404) {
        // Episodio huérfano (#2/R2): eliminar de "Seguir Viendo" y avisar sin error crudo
        removeContinueWatchingItem(episode.id);
        setPlayingStreamData((prev: any) =>
          prev?.episodeId === episode.id ? null : prev
        );
        setOrphanNotice(
          `"${showTitle} — ${resolvedTitle}" ya no está disponible en el catálogo y fue eliminado de Seguir Viendo.`
        );
        return;
      }
      if (!res.ok) throw new Error('No se pudo resolver el video');
      const data = await res.json();

      // 2. Transición fluida con los streams listos
      setPlayingStreamData((prev: any) => {
        if (!prev || prev.episodeId !== episode.id) return prev;
        return {
          ...prev,
          title: `${showTitle} - ${resolvedTitle}`,
          streamUrl: data.stream_url,
          all_streams: data.all_available_streams,
          ranked_streams: data.ranked_streams,
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

    // Filtro por categoría
    if (activeFilter !== 'all') {
      const filterKey = activeFilter.toLowerCase();
      result = result.filter((s) => {
        const cat = (s.category || '').toLowerCase();
        const title = (s.title || '').toLowerCase();
        const genresStr = Array.isArray(s.genres) ? s.genres.join(' ').toLowerCase() : String(s.genres || '').toLowerCase();

        if (filterKey === 'anime') return cat.includes('anime') || genresStr.includes('anime');
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

    // Filtro por año
    if (yearFilter !== null) {
      result = result.filter((s) => Number(s.year) === yearFilter);
    }

    // Búsqueda con scoring: prioriza coincidencias exactas y normaliza tildes
    if (searchQuery && searchQuery.trim().length >= 2) {
      result = searchShows(result, searchQuery);
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
  }, [shows, activeFilter, searchQuery, yearFilter, sortBy]);

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
    <div className="relative min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans selection:bg-amber-500 selection:text-black overflow-x-hidden">
      {/* 1. DYNAMIC AMBIENT GLOW (RESPONDE AL COLOR DOMINANTE DEL CONTENIDO EN FOCO) */}
      <AmbientGlow dominantRgb={ambientRgb} />

      {/* HEADER UNIFICADO: LOGO, BUSCADOR Y CATEGORÍAS EN LA MISMA BARRA SUPERIOR */}
      <UnifiedHeader
        onSearchChange={setSearchQuery}
        activeFilter={activeFilter}
        onSelectCategory={(f) => { setActiveFilter(f); setGridPageSize(100); }}
      />

      <main className="relative z-10 flex-1 pb-24">
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
        {shows.length > 0 ? (
          <>
            {/* HERO BANNER PRINCIPAL (70% VH, KEN BURNS, PILL BUTTONS) */}
            {featuredShow && !searchQuery && activeFilter === 'all' && (
              <HeroBanner
                media={featuredShow}
                onPlay={() => handleOpenDetails(featuredShow)}
                onMoreInfo={() => handleOpenDetails(featuredShow)}
              />
            )}

            <div className={`max-w-7xl mx-auto px-4 sm:px-8 space-y-12 ${featuredShow && !searchQuery && activeFilter === 'all' ? '-mt-12 sm:-mt-16' : 'pt-8'}`}>

              {/* CASO A: SI LA PESTAÑA ACTIVA ES 'RECOMMENDATIONS', MOSTRAR RIELES INTELIGENTES */}
              {activeFilter === 'recommendations' ? (
                <section className="space-y-10">
                  <div className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-800/80 pb-4">
                    <div>
                      <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-400 text-xs font-semibold mb-2">
                        <Sparkles size={13} />
                        <span>Algoritmo de Recomendación Nitiflix</span>
                      </div>
                      <h3 className="font-display text-2xl sm:text-3xl font-bold text-white tracking-tight">
                        {isAuthenticated && user ? `Recomendaciones para ${user.username}` : 'Recomendaciones y Tendencias'}
                      </h3>
                      <p className="text-xs sm:text-sm text-zinc-400 mt-1">
                        {isAuthenticated
                          ? 'Seleccionado inteligentemente según tu historial y hábitos de reproducción.'
                          : 'Inicia sesión para que el algoritmo aprenda tus gustos exactos con el tiempo.'}
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
                      onHoverMedia={handleHoverMedia}
                      isLoading={isLoadingRecs}
                    />
                  ))}

                  {recommendationRails.length === 0 && !isLoadingRecs && (
                    <div className="py-16 text-center space-y-3">
                      <Sparkles size={36} className="mx-auto text-amber-400/50" />
                      <p className="text-sm text-zinc-400 font-medium">
                        Empieza a reproducir contenido para que el algoritmo aprenda tus gustos.
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
                  onLoadMore={() => setCatalogPageSize((prev) => prev + 100)}
                  availableYears={availableYears}
                  onSelectMedia={handleOpenDetails}
                  onHoverMedia={handleHoverMedia}
                />
              ) : searchQuery || activeFilter !== 'all' ? (
                <section className="space-y-4">
                  <div className="flex items-center justify-between border-b border-zinc-800/80 pb-3">
                    <h3 className="font-display text-xl sm:text-2xl font-bold text-white tracking-tight">
                      {searchQuery
                        ? `Resultados para "${searchQuery}"`
                        : `Catálogo: ${activeFilter.toUpperCase()}`}
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
                            onHover={handleHoverMedia}
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
                      onPlayEpisode={(_showId, ep, title) => handleSelectEpisode(ep, title)}
                      onSelectShow={(showId) => {
                        const target = shows.find((s) => s.id === showId);
                        if (target) handleOpenDetails(target);
                      }}
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
                      onHoverMedia={handleHoverMedia}
                      isLoading={isLoadingRecs}
                    />
                  ))}

                  {/* RECÉN AGREGADOS (por fecha de ingesta, lo más nuevo primero) */}
                  <MediaRow
                    title="Recién Agregados"
                    items={shows.slice(0, 50)}
                    onSelectMedia={handleOpenDetails}
                    onHoverMedia={handleHoverMedia}
                    isLoading={isLoading}
                  />

                  {/* CUADRÍCULA ASIMÉTRICA BENTO BOX */}
                  {topRatedShows.length >= 3 && (
                    <BentoCollection
                      title="Destacados por la Crítica"
                      items={topRatedShows}
                      onSelectMedia={handleOpenDetails}
                      onHover={handleHoverMedia}
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
                      onHoverMedia={handleHoverMedia}
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
                      onHoverMedia={handleHoverMedia}
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
                              onHover={handleHoverMedia}
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

      {/* 3. VISTA DE DETALLES (DRAWER / PANEL LATERAL FLOTANTE QUE SE DESLIZA DESDE LA DERECHA) */}
      <MediaDetailsModal
        showId={selectedShowId}
        isOpen={Boolean(selectedShowId)}
        onClose={() => setSelectedShowId(null)}
        onSelectEpisode={(ep, title) => handleSelectEpisode(ep, title)}
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
          initialTime={playingStreamData.initialTime}
          isLoading={playingStreamData.isLoading}
          loadError={playingStreamData.loadError}
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
                const filtered = prev.filter((p) => p.showId !== playingStreamData.showId);
                const updated = [newProgress, ...filtered].slice(0, 12);
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
          // Playable = medio directo (.m3u8/.mp4/...) o embed de host conocido;
          // lo demás son páginas web crudas que requieren resolución JIT.
          const isPlayable = (u: string) =>
            /\.(m3u8|mp4|webm|mkv)(\?|#|$)/i.test(u) || isEmbedUrl(u);
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
