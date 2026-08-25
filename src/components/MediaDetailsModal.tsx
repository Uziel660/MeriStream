// src/components/MediaDetailsModal.tsx
import React, { useEffect, useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Play, Loader2, AlertCircle, Search, Calendar, Star } from 'lucide-react';
import { contentLabel } from '../utils/labels';
import { extractDominantColor, rgbToRgbaString } from '../utils/colorExtractor';
import { thumbBackdropUrl } from '../utils/imageSizes';
import { SmartImage } from './SmartImage';
import type { ShowDetail, Episode } from '../types';

interface MediaDetailsModalProps {
  showId: string | null;
  isOpen?: boolean;
  onClose: () => void;
  onSelectEpisode: (episode: Episode, showTitle: string) => void;
}

export const MediaDetailsModal: React.FC<MediaDetailsModalProps> = ({
  showId,
  isOpen = Boolean(showId),
  onClose,
  onSelectEpisode,
}) => {
  const [show, setShow] = useState<ShowDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [episodeSearch, setEpisodeSearch] = useState('');
  const [selectedSeason, setSelectedSeason] = useState<number>(1);
  const [accentRgb, setAccentRgb] = useState<[number, number, number]>([245, 158, 11]);

  useEffect(() => {
    if (!isOpen || !showId) return;

    setIsLoading(true);
    setError(null);
    setEpisodeSearch('');

    fetch(`/api/v1/shows/${showId}`)
      .then((res) => {
        if (!res.ok) throw new Error('No se pudo cargar la información del título.');
        return res.json();
      })
      .then((data: ShowDetail) => {
        setShow(data);
        const img = data.backdrop_url || data.poster_url;
        if (img) {
          extractDominantColor(img, data.title).then(setAccentRgb);
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setIsLoading(false));
  }, [isOpen, showId]);

  // Cerrar con Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const episodes = show?.episodes ? [...show.episodes].sort((a, b) => (a.episode_number || 0) - (b.episode_number || 0)) : [];

  // Extract seasons: prioriza el título del show ("TP2"/"Temporada 2") sobre
  // heurísticas por episodio; legacy sin marcadores cae a temporada 1.
  const seasonData = useMemo(() => {
    const seasonsMap = new Map<number, Episode[]>();

    const titleMatch = (show?.title || '').match(/\b(?:T|S|TP|Temporada\s*|Season\s*)-?\s*(\d{1,2})\b/i);
    const showSeason = titleMatch ? parseInt(titleMatch[1], 10) : null;

    episodes.forEach(ep => {
      let season = showSeason ?? 1;

      if (showSeason === null) {
        // Try to extract season from title (e.g. "T1E1", "S1 E2", "Season 1", "Temporada 2")
        const sMatch = ep.title.match(/\b(?:T|S|Season\s*|Temporada\s*)(\d+)\b/i);
        if (sMatch) {
          season = parseInt(sMatch[1], 10);
        }
      }

      if (!seasonsMap.has(season)) {
        seasonsMap.set(season, []);
      }
      seasonsMap.get(season)!.push(ep);
    });

    // Sort seasons
    const availableSeasons = Array.from(seasonsMap.keys()).sort((a, b) => a - b);

    return { seasonsMap, availableSeasons };
  }, [episodes, show?.title]);

  const { availableSeasons } = seasonData;

  // Auto-select first available season if current selectedSeason is not valid
  useEffect(() => {
    if (availableSeasons.length > 0 && !availableSeasons.includes(selectedSeason)) {
      setSelectedSeason(availableSeasons[0]);
    }
  }, [availableSeasons, selectedSeason]);

  const filteredEpisodes = useMemo(() => {
    // First filter by season
    const seasonEps = seasonData.seasonsMap.get(selectedSeason) || [];

    if (!episodeSearch) return seasonEps;

    const q = episodeSearch.toLowerCase().trim();
    return seasonEps.filter(
      (ep) =>
        ep.title.toLowerCase().includes(q) ||
        String(ep.episode_number).includes(q)
    );
  }, [seasonData, selectedSeason, episodeSearch]);

  const genresList: string[] = useMemo(() => {
    if (!show?.genres) return [show?.category || 'Anime'];
    if (Array.isArray(show.genres)) return show.genres;
    if (typeof show.genres === 'string') {
      return show.genres.split(',').map((g) => g.trim()).filter(Boolean);
    }
    return [show.category || 'Anime'];
  }, [show?.genres, show?.category]);

  const accentColor = rgbToRgbaString(accentRgb, 1);
  const glowStyle = rgbToRgbaString(accentRgb, 0.2);

  // Imagen de cabecera según fuente disponible: el backdrop 16:9 llena el hero
  // con object-cover; si solo hay poster 2:3 se muestra contenido (object-contain)
  // sobre un blur-fill del mismo poster para no recortar caras/títulos.
  const headerBackdrop = thumbBackdropUrl(show ?? {});
  const hasWideHeader = Boolean((show as any)?.backdrop_path || show?.banner_url || show?.backdrop_url);
  const headerImage = headerBackdrop ?? show?.poster_url ?? undefined;

  // ADVERTENCIA DE CONTENIDO SIN FUENTES (#19): obras importadas solo por
  // metadatos (ej. TVMaze) no tienen ningún stream reproducible. Avisar en la
  // UI antes de que el usuario dé play y reciba un error crudo.
  const playableEpisodes = episodes.filter((ep) => {
    const src = ep.source_url || '';
    if (!src) return false;
    // Las páginas HTML de episodios (tvmaze.com/episodes/...) no son media
    if (/tvmaze\.com\/episodes\//i.test(src)) return false;
    return /\.(m3u8|mp4|webm|mkv)(\?|#|$)/i.test(src) || /\/ver\//i.test(src);
  });
  const hasNoSources = !isLoading && !error && Boolean(show) && playableEpisodes.length === 0;

  return (
    <AnimatePresence>
      {isOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex justify-end bg-black/80 backdrop-blur-md animate-in fade-in duration-300"
          onClick={onClose}
        >
          {/* FLOATING SIDE PANEL SLIDING FROM RIGHT */}
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 28, stiffness: 260 }}
            onClick={(e) => e.stopPropagation()}
            className="relative flex h-full w-full max-w-2xl flex-col bg-zinc-950/95 border-l border-zinc-800/90 shadow-2xl overflow-hidden select-none"
          >
            {/* CLOSE BUTTON */}
            <button
              type="button"
              onClick={onClose}
              aria-label="Cerrar detalles"
              className="absolute right-4 top-4 z-20 flex h-10 w-10 items-center justify-center rounded-full bg-zinc-900/80 hover:bg-zinc-800 text-zinc-400 hover:text-white border border-zinc-800 backdrop-blur-md transition-colors"
            >
              <X size={18} />
            </button>

            {isLoading && (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 text-zinc-400">
                <Loader2 className="animate-spin text-amber-400" size={36} />
                <p className="text-xs font-mono text-zinc-400">Cargando episodios y servidores...</p>
              </div>
            )}

            {error && (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-rose-400">
                <AlertCircle size={36} />
                <p className="text-sm font-medium">{error}</p>
              </div>
            )}

            {!isLoading && !error && show && (
              <div className="flex flex-1 flex-col overflow-y-auto">

                {/* HERO HEADER OF THE SIDE PANEL */}
                <div className="relative h-72 sm:h-80 w-full shrink-0 overflow-hidden bg-zinc-900">
                  {headerImage && !hasWideHeader && (
                    <SmartImage
                      src={headerImage}
                      alt=""
                      aria-hidden="true"
                      className="absolute inset-0 h-full w-full object-cover scale-110 blur-2xl brightness-[0.35]"
                    />
                  )}
                  {headerImage && (
                    <SmartImage
                      src={headerImage}
                      alt={show.title}
                      className={`relative h-full w-full ${
                        hasWideHeader
                          ? 'object-cover filter brightness-90'
                          : 'object-contain object-top filter drop-shadow-lg'
                      }`}
                    />
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-zinc-950 via-zinc-950/60 to-transparent" />
                  <div
                    className="absolute inset-0 pointer-events-none opacity-40"
                    style={{
                      background: `radial-gradient(circle at 75% 30%, ${glowStyle} 0%, transparent 60%)`,
                    }}
                  />

                  {/* BOTTOM FLOATING INFO ON HEADER */}
                  <div className="absolute bottom-5 left-6 right-6 space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className="rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider backdrop-blur-md"
                        style={{
                          backgroundColor: rgbToRgbaString(accentRgb, 0.15),
                          borderColor: rgbToRgbaString(accentRgb, 0.3),
                          borderWidth: '1px',
                          color: accentColor,
                        }}
                      >
                        {contentLabel(show.category)}
                      </span>

                      {show.year && (
                        <span className="text-xs text-zinc-400 font-mono flex items-center gap-1">
                          <Calendar size={12} className="text-zinc-500" /> {show.year}
                        </span>
                      )}

                      {show.rating && (
                        <span className="rounded-md bg-black/80 px-2 py-0.5 text-xs font-bold text-amber-300 border border-amber-500/20 backdrop-blur-sm flex items-center gap-1">
                          <Star size={11} className="fill-amber-400 text-amber-400" />
                          {typeof show.rating === 'number' ? show.rating.toFixed(1) : show.rating}
                        </span>
                      )}
                    </div>

                    <h2 className="font-display text-2xl sm:text-3xl font-extrabold text-white leading-tight text-title-shadow">
                      {show.title}
                    </h2>
                  </div>
                </div>

                {/* CONTENT: SINOPSIS, GÉNEROS Y EPISODIOS */}
                <div className="p-6 space-y-6 flex-1">

                  {/* GÉNEROS EN CHIPS CON FONDO SEMI-TRANSPARENTE */}
                  {genresList.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {genresList.map((genre, idx) => (
                        <span
                          key={idx}
                          className="rounded-full bg-white/5 border border-white/10 px-3 py-1 text-xs text-zinc-300 font-medium backdrop-blur-sm"
                        >
                          {genre}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* SINOPSIS */}
                  <div className="space-y-1.5">
                    <h4 className="text-xs font-bold text-zinc-400 uppercase tracking-wider font-mono">
                      Sinopsis
                    </h4>
                    <p className="text-xs sm:text-sm text-zinc-300 leading-relaxed font-normal">
                      {show.description || 'Sin descripción disponible para esta obra.'}
                    </p>
                  </div>

                  {/* AVISO: SOLO METADATOS / SIN FUENTES DE VIDEO (#19) */}
                  {hasNoSources && (
                    <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-300 flex items-start gap-2.5">
                      <AlertCircle size={15} className="shrink-0 mt-0.5" />
                      <span>
                        Esta obra se importó <strong>solo como metadatos</strong> y no tiene
                        fuentes de video reproducibles. Puedes explorar su ficha y episodios,
                        pero la reproducción no está disponible.
                      </span>
                    </div>
                  )}

                  {/* BOTÓN DE REPRODUCIR PARA PELÍCULAS O LISTA DE EPISODIOS */}
                  {show.kind === 'movie' ||
                  (show as any).content_type === 'movie' ||
                  ['pelicula', 'película', 'peliculas', 'películas', 'movie', 'movies', 'cine'].includes(
                    (show.category || '').toLowerCase().trim()
                  ) ? (
                    <div className="pt-4 flex justify-center pb-8">
                      <button
                        type="button"
                        onClick={() => {
                          const movieEp =
                            episodes[0] ||
                            (show.episodes && show.episodes[0]) || {
                              id: show.id,
                              title: show.title || 'Película Completa',
                              episode_number: 1,
                              source_url: (show as any).source_url || show.sources?.master_m3u8 || '',
                            };
                          onSelectEpisode(movieEp, show.title);
                        }}
                        className="group relative flex items-center justify-center gap-3 w-full sm:w-auto px-12 py-4 rounded-xl bg-amber-500 hover:bg-amber-400 text-black font-display font-bold text-base transition-all hover:scale-105 shadow-[0_0_20px_rgba(245,158,11,0.4)] cursor-pointer"
                      >
                        <Play size={20} className="fill-black" />
                        REPRODUCIR PELÍCULA
                      </button>
                    </div>
                  ) : (
                  <div className="space-y-4 pt-2">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-zinc-800/80 pb-3">
                      <div className="flex items-center gap-2">
                        <div className="flex flex-col gap-2">
                          <h4 className="font-display text-sm font-bold text-white">
                            Episodios ({episodes.length})
                          </h4>
                          {availableSeasons.length > 1 && (
                            <div className="flex flex-wrap gap-2 mt-1">
                              {availableSeasons.map((season) => (
                                <button
                                  key={season}
                                  onClick={() => setSelectedSeason(season)}
                                  className={`px-3 py-1 text-xs rounded-full transition-colors border ${
                                    selectedSeason === season
                                      ? 'bg-amber-500/20 border-amber-500/50 text-amber-400 font-bold'
                                      : 'bg-zinc-800/50 border-zinc-700/50 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
                                  }`}
                                >
                                  Temporada {season}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>

                      {episodes.length > 6 && (
                        <div className="relative flex items-center">
                          <Search
                            size={13}
                            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none"
                          />
                          <input
                            type="text"
                            value={episodeSearch}
                            onChange={(e) => setEpisodeSearch(e.target.value)}
                            placeholder="Buscar nº o título..."
                            className="rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-200 placeholder-zinc-500 pl-8 pr-3 py-1.5 focus:border-amber-500/60 focus:outline-none w-full sm:w-48 font-normal"
                          />
                        </div>
                      )}
                    </div>

                    {filteredEpisodes.length === 0 ? (
                      <div className="text-center py-10 text-xs text-zinc-500">
                        No se encontraron episodios {episodeSearch ? `que coincidan con "${episodeSearch}"` : 'registrados'}.
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 max-h-[420px] overflow-y-auto pr-1">
                        {filteredEpisodes.map((ep) => {
                          return (
                            <button
                              key={ep.id}
                              type="button"
                              onClick={() => onSelectEpisode(ep, show.title)}
                              className="group/ep w-full flex items-center justify-between rounded-xl bg-zinc-900/60 hover:bg-zinc-800/70 p-3 text-left border border-zinc-800/80 hover:border-zinc-700 transition-all shadow-sm"
                            >
                              <div className="flex flex-col truncate pr-3">
                                <span className="font-display text-xs font-semibold text-zinc-200 group-hover/ep:text-amber-400 truncate transition-colors">
                                  {ep.title}
                                </span>
                                <span className="text-[11px] text-zinc-500 font-mono mt-0.5">
                                  Episodio {ep.episode_number}
                                </span>
                              </div>

                              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-zinc-800 text-zinc-300 group-hover/ep:bg-amber-500 group-hover/ep:text-black transition-colors shrink-0">
                                <Play size={13} className="ml-0.5 fill-current" />
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  )}
                </div>
              </div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};
