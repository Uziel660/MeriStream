// src/App.tsx
import { useEffect, useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { UnifiedHeader } from './components/UnifiedHeader';
import { AllCategoriesModal } from './components/AllCategoriesModal';
import { HeroBanner } from './components/HeroBanner';
import { MediaRow } from './components/MediaRow';
import { MediaCard } from './components/MediaCard';
import { MediaDetailsModal } from './components/MediaDetailsModal';
import { HLSPlayerModal } from './components/HLSPlayerModal';
import { AdminPanel } from './components/AdminPanel';
import { AmbientGlow } from './components/AmbientGlow';
import { ContinueWatching, type WatchProgress } from './components/ContinueWatching';
import { BentoCollection } from './components/BentoCollection';
import { extractDominantColor } from './utils/colorExtractor';
import { isEmbedUrl } from './utils/streamOptimizer';
import { api } from './api/client';
import { RefreshCw, Film, Tv, ArrowUpRight } from 'lucide-react';
import type { Show, Episode } from './types';

const STORAGE_CONTINUE_KEY = 'nitiflix_continue_watching_v1';

export function App() {
  const [shows, setShows] = useState<Show[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<string>('all');
  const [allGenresList, setAllGenresList] = useState<string[]>([]);
  const [isCategoriesModalOpen, setIsCategoriesModalOpen] = useState(false);

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

  // Modal States
  const [selectedShowId, setSelectedShowId] = useState<string | null>(null);
  const [playingStreamData, setPlayingStreamData] = useState<any | null>(null);
  const [isAdminOpen, setIsAdminOpen] = useState(false);

  // Fetch all genres from server API (Anime & Movies/Series APIs)
  useEffect(() => {
    const fetchGenres = async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/api/v1/genres`);
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

  // 1. Cargar el catálogo
  const loadCatalog = async () => {
    try {
      setIsLoading(true);
      const url = searchQuery
        ? `/api/v1/shows?search=${encodeURIComponent(searchQuery)}`
        : '/api/v1/shows';

      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          const safeShows: Show[] = data.map((s: any) => ({
            id: s.id || `show-${Math.random()}`,
            title: s.title || 'Sin Título',
            description: s.description || s.synopsis || '',
            synopsis: s.description || s.synopsis || '',
            poster_url: s.poster_url || '',
            banner_url: s.banner_url || s.poster_url || '',
            backdrop_url: s.backdrop_url || s.banner_url || s.poster_url || '',
            category: s.category || 'anime',
            rating: s.rating || 8.2,
            year: s.year || 2024,
            genres: s.genres || ['Anime'],
            sources: {
              master_m3u8: `/api/v1/media/${s.id}/stream`,
              fallback_mp4: null,
              qualities: [],
              subtitles: [],
            },
          }));
          setShows(safeShows);

          // Update ambient glow from first show if available
          if (safeShows.length > 0) {
            const firstImg = safeShows[0].poster_url || safeShows[0].banner_url;
            if (firstImg) {
              extractDominantColor(firstImg, safeShows[0].title).then(setAmbientRgb);
            }
          }
        }
      }
    } catch (e) {
      console.error('Error cargando catálogo:', e);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadCatalog();
  }, [searchQuery]);

  const handleOpenDetails = (show: Show) => {
    if (show?.id) {
      setSelectedShowId(show.id);
      const img = show.poster_url || show.banner_url;
      if (img) {
        extractDominantColor(img, show.title).then(setAmbientRgb);
      }
    }
  };

  const handleHoverMedia = (show: Show) => {
    const img = show.poster_url || show.banner_url;
    if (img) {
      extractDominantColor(img, show.title).then(setAmbientRgb);
    }
  };

  const handleSelectEpisode = async (episode: Episode, showTitle: string) => {
    const showId = episode.show_id || selectedShowId || 'unknown';
    const currentShow = shows.find((s) => s.id === showId);
    const existingProgress = continueWatchingItems.find(p => p.showId === showId && p.episodeId === episode.id);
    const initialTime = existingProgress?.currentTime || 0;

    // 1. Abrir el reproductor al instante para feedback visual inmediato
    setPlayingStreamData({
      title: `${showTitle} - ${episode.title}`,
      streamUrl: '',
      all_streams: [],
      initialTime,
      showId,
      showTitle,
      showPoster: currentShow?.poster_url || undefined,
      episodeId: episode.id,
      episodeNumber: episode.episode_number,
      episodeTitle: episode.title,
      isLoading: true,
    });

    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/play/${episode.id}`);
      if (!res.ok) throw new Error('No se pudo resolver el video');
      const data = await res.json();

      // 2. Transición fluida con los streams listos
      setPlayingStreamData((prev: any) => {
        if (!prev || prev.episodeId !== episode.id) return prev;
        return {
          ...prev,
          streamUrl: data.stream_url,
          all_streams: data.all_available_streams,
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
    if (activeFilter === 'all') return shows;
    const filterKey = activeFilter.toLowerCase();

    return shows.filter((s) => {
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

      // Búsqueda genérica por género
      return genresStr.includes(filterKey) || cat.includes(filterKey) || title.includes(filterKey);
    });
  }, [shows, activeFilter]);

  // Secciones divididas para la pantalla de inicio
  const animeShows = useMemo(
    () => shows.filter((s) => (s.category || '').toLowerCase().includes('anime')),
    [shows]
  );
  const otherShows = useMemo(
    () => shows.filter((s) => !(s.category || '').toLowerCase().includes('anime')),
    [shows]
  );
  const topRatedShows = useMemo(
    () => [...shows].sort((a, b) => (b.rating || 0) - (a.rating || 0)).slice(0, 10),
    [shows]
  );

  // Algoritmo de Recomendación Inteligente basado en el historial de Continue Watching
  const { recommendedShows, topGenre } = useMemo(() => {
    if (!continueWatchingItems || continueWatchingItems.length === 0 || shows.length === 0) {
      return { recommendedShows: [], topGenre: null };
    }

    // 1. Contar frecuencia de géneros vistos recientemente
    const genreScore: Record<string, number> = {};
    const watchedShowIds = new Set(continueWatchingItems.map((item) => item.showId));

    continueWatchingItems.forEach((item) => {
      const show = shows.find((s) => s.id === item.showId);
      if (show && Array.isArray(show.genres)) {
        show.genres.forEach((g) => {
          const clean = g.trim();
          if (
            clean &&
            clean.toLowerCase() !== 'anime' &&
            clean.toLowerCase() !== 'película' &&
            clean.toLowerCase() !== 'serie'
          ) {
            genreScore[clean] = (genreScore[clean] || 0) + 1;
          }
        });
      }
    });

    // Encontrar el género dominante
    let maxGenre = '';
    let maxCount = 0;
    for (const [genre, count] of Object.entries(genreScore)) {
      if (count > maxCount) {
        maxCount = count;
        maxGenre = genre;
      }
    }

    if (!maxGenre) {
      return { recommendedShows: [], topGenre: null };
    }

    // 2. Filtrar shows que compartan ese género y que no hayan sido vistos aún
    const recommendations = shows.filter((s) => {
      if (watchedShowIds.has(s.id)) return false;
      const genresStr = Array.isArray(s.genres)
        ? s.genres.join(' ').toLowerCase()
        : String(s.genres || '').toLowerCase();
      return genresStr.includes(maxGenre.toLowerCase());
    });

    // Ordenar por rating
    const sorted = [...recommendations].sort((a, b) => (b.rating || 0) - (a.rating || 0));

    return {
      recommendedShows: sorted.slice(0, 10),
      topGenre: maxGenre,
    };
  }, [continueWatchingItems, shows]);

  const featuredShow = filteredShows.length > 0 ? filteredShows[0] : (shows.length > 0 ? shows[0] : null);

  return (
    <div className="relative min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans selection:bg-amber-500 selection:text-black overflow-x-hidden">
      {/* 1. DYNAMIC AMBIENT GLOW (RESPONDE AL COLOR DOMINANTE DEL CONTENIDO EN FOCO) */}
      <AmbientGlow dominantRgb={ambientRgb} />

      {/* HEADER UNIFICADO: LOGO, BUSCADOR, PANEL Y CATEGORÍAS EN LA MISMA BARRA SUPERIOR */}
      <UnifiedHeader
        onSearchChange={setSearchQuery}
        onOpenAdmin={() => setIsAdminOpen(true)}
        activeFilter={activeFilter}
        onSelectCategory={setActiveFilter}
        onOpenAllCategories={() => setIsCategoriesModalOpen(true)}
      />

      <main className="relative z-10 flex-1 pb-24">
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

              {/* CASO A: SI HAY UN FILTRO ESPECÍFICO O BÚSQUEDA ACTIVA, MOSTRAR GRID DINÁMICO */}
              {searchQuery || activeFilter !== 'all' ? (
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
                        }}
                        className="text-xs text-amber-400 hover:underline font-semibold"
                      >
                        Restablecer filtros
                      </button>
                    </div>
                  ) : (
                    <motion.div
                      layout
                      className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 sm:gap-5"
                    >
                      <AnimatePresence>
                        {filteredShows.map((item) => (
                          <motion.div
                            key={item.id}
                            layout
                            initial={{ opacity: 0, scale: 0.95 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.95 }}
                            transition={{ duration: 0.25 }}
                          >
                            <MediaCard
                              media={item}
                              onSelectMedia={handleOpenDetails}
                              onHover={handleHoverMedia}
                            />
                          </motion.div>
                        ))}
                      </AnimatePresence>
                    </motion.div>
                  )}
                </section>
              ) : (
                /* CASO B: VISTA PRINCIPAL CON ESTRUCTURA DIVERSIFICADA (SEGUIR VIENDO + BENTO BOX + FILAS) */
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

                  {/* RECOMENDACIONES PERSONALIZADAS POR GÉNERO CONSUMIDO */}
                  {recommendedShows.length > 0 && topGenre && (
                    <MediaRow
                      title={`Porque te gusta ${topGenre}`}
                      items={recommendedShows}
                      onSelectMedia={handleOpenDetails}
                      onHoverMedia={handleHoverMedia}
                      isLoading={isLoading}
                    />
                  )}

                  {/* CUADRÍCULA ASIMÉTRICA BENTO BOX */}
                  {topRatedShows.length >= 3 && (
                    <BentoCollection
                      title="Destacados por la Crítica"
                      items={topRatedShows}
                      onSelectMedia={handleOpenDetails}
                      onHover={handleHoverMedia}
                    />
                  )}

                  {/* FILAS DE CATÁLOGO */}
                  <MediaRow
                    title="Novedades & Tendencias"
                    items={shows}
                    onSelectMedia={handleOpenDetails}
                    onHoverMedia={handleHoverMedia}
                    isLoading={isLoading}
                  />

                  {animeShows.length > 0 && (
                    <MediaRow
                      title="Anime & Animación Japonesa"
                      items={animeShows}
                      onSelectMedia={handleOpenDetails}
                      onHoverMedia={handleHoverMedia}
                      isLoading={isLoading}
                    />
                  )}

                  {otherShows.length > 0 && (
                    <MediaRow
                      title="Series & Cine Internacional"
                      items={otherShows}
                      onSelectMedia={handleOpenDetails}
                      onHoverMedia={handleHoverMedia}
                      isLoading={isLoading}
                    />
                  )}
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
                  onClick={() => setIsAdminOpen(true)}
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
                  onClick={() => setIsAdminOpen(true)}
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

      {/* MODAL DE TODAS LAS CATEGORÍAS Y GÉNEROS (DESDE APIS DE ANIME, CINE Y SERIES) */}
      <AllCategoriesModal
        isOpen={isCategoriesModalOpen}
        onClose={() => setIsCategoriesModalOpen(false)}
        allGenres={allGenresList}
        activeFilter={activeFilter}
        onSelectCategory={(category) => {
          setActiveFilter(category);
          setIsCategoriesModalOpen(false);
        }}
        showsCountByGenre={showsCountByGenre}
      />

      {/* REPRODUCTOR HLS Y PROXY DE VIDEO JUST-IN-TIME */}
      {playingStreamData && (
        <HLSPlayerModal
          isOpen={Boolean(playingStreamData)}
          onClose={() => setPlayingStreamData(null)}
          title={playingStreamData.title}
          streamUrl={playingStreamData.streamUrl}
          all_streams={playingStreamData.all_streams}
          initialTime={playingStreamData.initialTime}
          isLoading={playingStreamData.isLoading}
          loadError={playingStreamData.loadError}
          onProgressUpdate={(currentTime, duration) => {
            if (duration > 0 && currentTime > 0) {
              const progressPercent = Math.round((currentTime / duration) * 100);

              setContinueWatchingItems((prev) => {
                const filtered = prev.filter((p) => p.showId !== playingStreamData.showId);
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

                const updated = [newProgress, ...filtered].slice(0, 8);
                try {
                  localStorage.setItem(STORAGE_CONTINUE_KEY, JSON.stringify(updated));
                } catch {}
                return updated;
              });
            }
          }}
        />
      )}

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
