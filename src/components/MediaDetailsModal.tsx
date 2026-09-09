// src/components/MediaDetailsModal.tsx
import React, { useEffect, useState, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Play, Loader2, AlertCircle, Search, Calendar, Star, Check, RotateCcw, ChevronDown, Film } from 'lucide-react';
import { contentLabel } from '../utils/labels';
import { extractDominantColor, rgbToRgbaString } from '../utils/colorExtractor';
import { heroBackdropSrcSet, heroBackdropUrl } from '../utils/imageSizes';
import { cleanDescription, cleanDisplayTitle, cleanDisplayGenres } from '../utils/textCleaner';
import { SmartImage } from './SmartImage';
import { MediaCard } from './MediaCard';
import { useHiddenGenres } from '../hooks/useHiddenGenres';
import { displayEpisodeTitle } from '../utils/episodeLabels';
import type { Show, ShowDetail, Episode } from '../types';
import { useDialogFocus } from '../hooks/useDialogFocus';
import type { WatchProgress } from './ContinueWatching';
import { getAppPreferences } from '../utils/appPreferences';

function parsePublicCatalogId(value: string): { kind: 'movie' | 'series' | 'anime'; tmdbId: number } | null {
  const match = /^tmdb-(movie|series|anime)-(\d+)$/.exec(String(value || ''));
  if (!match) return null;
  const tmdbId = Number(match[2]);
  return Number.isInteger(tmdbId) && tmdbId > 0
    ? { kind: match[1] as 'movie' | 'series' | 'anime', tmdbId }
    : null;
}

interface MediaDetailsModalProps {
  showId: string | null;
  isOpen?: boolean;
  onClose: () => void;
  onSelectEpisode: (episode: Episode, showTitle: string) => void;
  onSelectShow?: (show: Show) => void;
  watchProgress?: WatchProgress[];
  userId?: string | null;
}

export const MediaDetailsModal: React.FC<MediaDetailsModalProps> = ({
  showId,
  isOpen = Boolean(showId),
  onClose,
  onSelectEpisode,
  onSelectShow,
  watchProgress = [],
  userId,
}) => {
  const dialogRef = useDialogFocus(isOpen);
  const [show, setShow] = useState<ShowDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [episodeSearch, setEpisodeSearch] = useState('');
  const [selectedSeason, setSelectedSeason] = useState<number>(1);
  const [visibleEpisodeCount, setVisibleEpisodeCount] = useState(12);
  const [isSeasonMenuOpen, setIsSeasonMenuOpen] = useState(false);
  const [relatedShows, setRelatedShows] = useState<Show[]>([]);
  const [isLoadingRelated, setIsLoadingRelated] = useState(false);
  const seasonMenuRef = useRef<HTMLDivElement>(null);
  const [accentRgb, setAccentRgb] = useState<[number, number, number]>([245, 158, 11]);

  useEffect(() => {
    if (!isOpen || !showId) return;

    setIsLoading(true);
    setError(null);
    setShow(null);
    setEpisodeSearch('');
    setSelectedSeason(1);
    setVisibleEpisodeCount(12);
    setIsSeasonMenuOpen(false);
    setRelatedShows([]);
    setIsLoadingRelated(false);

    const publicIdentity = parsePublicCatalogId(showId);
    const detailUrl = publicIdentity
      ? `/api/v1/catalog/public/${publicIdentity.kind}/${publicIdentity.tmdbId}`
      : `/api/v1/shows/${showId}`;

    const personalKey = getAppPreferences(userId).tmdbApiKey.trim();
    fetch(detailUrl, personalKey ? { headers: { 'X-TMDB-Personal-Key': personalKey } } : undefined)
      .then(async (res) => {
        if (!res.ok) throw new Error('No se pudo cargar la información del título.');
        const localData = await res.json() as ShowDetail;
        // Las tarjetas locales conservan los links reproducibles, pero algunas
        // fueron importadas con el título del proveedor en inglés. Cuando hay
        // TMDB ID, hidratar solo la presentación con la ficha es-419 canónica;
        // episodios, providers y el id local permanecen intactos para playback.
        if (!publicIdentity && Number(localData.tmdb_id) > 0) {
          const rawKind = String(localData.category || localData.kind || '').toLowerCase();
          const publicKind = rawKind.includes('movie') || rawKind.includes('pel')
            ? 'movie'
            : rawKind.includes('anime')
              ? 'anime'
              : 'series';
          try {
            const localizedResponse = await fetch(`/api/v1/catalog/public/${publicKind}/${localData.tmdb_id}`, personalKey ? { headers: { 'X-TMDB-Personal-Key': personalKey } } : undefined);
            if (localizedResponse.ok) {
              const localized = await localizedResponse.json() as Partial<ShowDetail>;
              return {
                ...localData,
                title: localized.title || localData.title,
                original_title: localized.original_title || localData.original_title,
                description: localized.description || localData.description,
                synopsis: localized.synopsis || localized.description || localData.synopsis,
                poster_url: localized.poster_url || localData.poster_url,
                poster_path: localized.poster_path || localData.poster_path,
                banner_url: localized.banner_url || localData.banner_url,
                backdrop_url: localized.backdrop_url || localData.backdrop_url,
                backdrop_path: localized.backdrop_path || localData.backdrop_path,
                logo_url: localized.logo_url || localData.logo_url,
                genres: localized.genres?.length ? localized.genres : localData.genres,
                year: localized.year || localData.year,
                rating: localized.rating || localData.rating,
                tmdb_id: localized.tmdb_id || localData.tmdb_id,
                episodes: localData.episodes?.length ? localData.episodes : (localized.episodes || []),
              } as ShowDetail;
            }
          } catch {
            // Si TMDB no responde, la ficha local sigue siendo reproducible.
          }
        }
        return localData;
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
  }, [isOpen, showId, userId]);

  // Related titles arrive after the main sheet so they never delay playback
  // or the useful metadata above. The API keeps the TMDB key server-side.
  useEffect(() => {
    const tmdbId = Number(show?.tmdb_id);
    if (!isOpen || !show || !Number.isInteger(tmdbId) || tmdbId <= 0) {
      setRelatedShows([]);
      setIsLoadingRelated(false);
      return;
    }

    const rawCategory = String(show.category || show.kind || '').toLowerCase();
    const kind = rawCategory.includes('movie') || rawCategory.includes('pel') ? 'movie'
      : rawCategory.includes('anime') ? 'anime' : 'series';
    const controller = new AbortController();
    const personalKey = getAppPreferences(userId).tmdbApiKey.trim();
    setIsLoadingRelated(true);

    fetch(`/api/v1/catalog/public/${kind}/${tmdbId}/related`, {
      signal: controller.signal,
      ...(personalKey ? { headers: { 'X-TMDB-Personal-Key': personalKey } } : {}),
    })
      .then(async (response) => {
        if (!response.ok) return [];
        const payload = await response.json();
        const items = Array.isArray(payload) ? payload : payload?.shows;
        return Array.isArray(items) ? items as Show[] : [];
      })
      .then((items) => {
        if (!controller.signal.aborted) setRelatedShows(items.filter((item) => item?.id && item.id !== show.id));
      })
      .catch((reason) => {
        if (reason?.name !== 'AbortError') setRelatedShows([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoadingRelated(false);
      });

    return () => controller.abort();
  }, [isOpen, show, userId]);

  // Cerrar con Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (!isSeasonMenuOpen) return;
    const handleOutsidePointer = (event: PointerEvent) => {
      if (seasonMenuRef.current && !seasonMenuRef.current.contains(event.target as Node)) {
        setIsSeasonMenuOpen(false);
      }
    };
    window.addEventListener('pointerdown', handleOutsidePointer);
    return () => window.removeEventListener('pointerdown', handleOutsidePointer);
  }, [isSeasonMenuOpen]);

  // ── MAPA DE PROGRESO DE EPISODIOS DE ESTA OBRA ──────────────────────
  const episodeProgressMap = useMemo(() => {
    const map = new Map<string, { percent: number; currentTime: number; duration: number }>();
    if (!watchProgress || !showId) return map;

    for (const p of watchProgress) {
      if (p.showId === showId) {
        const percent = Math.min(100, Math.max(0, Math.round(p.progressPercent || 0)));
        map.set(p.episodeId, {
          percent,
          currentTime: p.currentTime || 0,
          duration: p.duration || 0,
        });
        if (typeof p.episodeNumber === 'number') {
          map.set(`num_${p.episodeNumber}`, {
            percent,
            currentTime: p.currentTime || 0,
            duration: p.duration || 0,
          });
        }
      }
    }
    return map;
  }, [watchProgress, showId]);

  const episodes = show?.episodes ? [...show.episodes].sort((a, b) => (a.episode_number || 0) - (b.episode_number || 0)) : [];

  // Extract seasons: prioriza el título del show ("TP2"/"Temporada 2") sobre
  // heurísticas por episodio; legacy sin marcadores cae a temporada 1.
  const seasonData = useMemo(() => {
    const seasonsMap = new Map<number, Episode[]>();

    const titleMatch = (show?.title || '').match(/\b(?:T|S|TP|Temporada\s*|Season\s*)-?\s*(\d{1,2})\b/i);
    const showSeason = titleMatch ? parseInt(titleMatch[1], 10) : null;

    episodes.forEach(ep => {
      const episodeSeason = Number((ep as any).season_number);
      let season = Number.isFinite(episodeSeason) && episodeSeason > 0
        ? episodeSeason
        : (showSeason ?? 1);

      if (showSeason === null && !(Number.isFinite(episodeSeason) && episodeSeason > 0)) {
        // Try to extract season from title (e.g. "T1E1", "S1 E2", "Season 1", "Temporada 2")
        const rawEpisodeTitle = typeof ep.title === 'string' ? ep.title : '';
        const sMatch = rawEpisodeTitle.match(/\b(?:T|S|Season\s*|Temporada\s*)(\d+)\b/i);
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
        displayEpisodeTitle(ep.title, ep.episode_number).toLowerCase().includes(q) ||
        String(ep.episode_number).includes(q)
    );
  }, [seasonData, selectedSeason, episodeSearch]);

  useEffect(() => {
    // Searching can show a useful first window immediately; normal browsing
    // stays intentionally small so a 300-episode season never floods the DOM.
    setVisibleEpisodeCount(episodeSearch.trim() ? 50 : 12);
  }, [selectedSeason, episodeSearch, showId]);

  const displayedEpisodes = useMemo(
    () => filteredEpisodes.slice(0, visibleEpisodeCount),
    [filteredEpisodes, visibleEpisodeCount],
  );

  const { isGenreHidden } = useHiddenGenres();

  const genresList: string[] = useMemo(() => {
    let genres: string[];
    if (!show?.genres) return [show?.category || 'Anime'];
    if (Array.isArray(show.genres)) genres = show.genres;
    else if (typeof show.genres === 'string') genres = show.genres.split(',').map((g) => g.trim()).filter(Boolean);
    else return [show.category || 'Anime'];
    return cleanDisplayGenres(genres).filter((g) => !isGenreHidden(g));
  }, [show?.genres, show?.category, isGenreHidden]);

  const accentColor = rgbToRgbaString(accentRgb, 1);
  const glowStyle = rgbToRgbaString(accentRgb, 0.2);

  // Imagen de cabecera según fuente disponible: el backdrop 16:9 llena el hero
  // con object-cover; si solo hay poster 2:3 se muestra contenido (object-contain)
  // sobre un blur-fill del mismo poster para no recortar caras/títulos.
  const headerBackdrop = heroBackdropUrl(show ?? {});
  const headerBackdropSrcSet = heroBackdropSrcSet(show ?? {});
  const hasWideHeader = Boolean((show as any)?.backdrop_path || show?.banner_url || show?.backdrop_url);
  const headerImage = headerBackdrop ?? show?.poster_url ?? undefined;

  // ADVERTENCIA DE CONTENIDO SIN FUENTES (#19):
  // Solo se alerta si realmente no existe ningún episodio con fuente válida
  // ni enlaces directos a stream en la obra.
  const isMetadataOnlyUrl = (url?: string | null): boolean => {
    if (!url || typeof url !== 'string') return true;
    const clean = url.trim().toLowerCase();
    if (!clean) return true;
    return /tvmaze\.com\/episodes\/|themoviedb\.org|anidb\.net|myanimelist\.net/i.test(clean);
  };

  const hasDirectSource = Boolean(
    ((show as any)?.source_url && !isMetadataOnlyUrl((show as any).source_url)) ||
    (show?.sources?.master_m3u8 && !isMetadataOnlyUrl(show.sources.master_m3u8))
  );

  const playableEpisodes = episodes.filter((ep) => !isMetadataOnlyUrl(ep.source_url));
  const hasNoSources = !isLoading && !error && Boolean(show) && playableEpisodes.length === 0 && !hasDirectSource;

  const isMovie = Boolean(
    show &&
    (show.kind === 'movie' ||
      (show as any).content_type === 'movie' ||
      ['pelicula', 'película', 'peliculas', 'películas', 'movie', 'movies', 'cine'].includes(
        (show.category || '').toLowerCase().trim()
      ) ||
      (episodes.length === 1 && !/episodio|capitulo|capítulo/i.test(String(episodes[0].title || ''))))
  );

  // Progreso de película
  const movieEpisode = episodes[0] || (show?.episodes && show.episodes[0]) || {
    id: show?.id || 'movie',
    title: show?.title || 'Película Completa',
    episode_number: 1,
    source_url: (show as any)?.source_url || show?.sources?.master_m3u8 || '',
  };
  const movieProgress = episodeProgressMap.get(movieEpisode.id) || episodeProgressMap.get('num_1');
  const moviePercent = movieProgress?.percent || 0;
  const isMovieCompleted = moviePercent >= 88;

  return (
    <AnimatePresence>
      {isOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={show ? `Detalles de ${show.title}` : 'Detalles del título'}
          className="details-overlay fixed inset-0 z-50 flex justify-end bg-black/80 backdrop-blur-md animate-in fade-in duration-300"
          onClick={onClose}
        >
          {/* FLOATING SIDE PANEL SLIDING FROM RIGHT */}
          <motion.div
            ref={dialogRef}
            tabIndex={-1}
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 28, stiffness: 260 }}
            onClick={(e) => e.stopPropagation()}
            className="details-panel relative flex w-full flex-col bg-zinc-950/95 border-l border-zinc-800/90 shadow-2xl overflow-hidden select-none"
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
              <div className="details-scroll flex flex-1 flex-col overflow-y-auto">

                {/* HERO HEADER OF THE SIDE PANEL */}
                <div className="details-hero relative h-72 sm:h-80 w-full shrink-0 overflow-hidden bg-zinc-900">
                  {headerImage && !hasWideHeader && (
                    <SmartImage
                      src={headerImage}
                      srcSet={headerBackdropSrcSet}
                      sizes="100vw"
                      alt=""
                      aria-hidden="true"
                      className="absolute inset-0 h-full w-full object-cover scale-110 blur-2xl brightness-[0.35]"
                    />
                  )}
                  {headerImage && (
                    <SmartImage
                      src={headerImage}
                      srcSet={headerBackdropSrcSet}
                      sizes="100vw"
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
                    className="details-glow absolute inset-0 pointer-events-none opacity-40"
                    style={{
                      background: `radial-gradient(circle at 75% 30%, ${glowStyle} 0%, transparent 60%)`,
                    }}
                  />

                  {/* BOTTOM FLOATING INFO ON HEADER */}
                  <div className="absolute bottom-5 left-6 right-6 space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className="details-category rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider backdrop-blur-md"
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

                    {show.logo_url ? (
                      <div>
                        <SmartImage
                          src={show.logo_url}
                          alt={cleanDisplayTitle(show.title)}
                          className="details-title-logo max-h-16 sm:max-h-20 max-w-[min(84vw,26rem)] object-contain object-left drop-shadow-[0_3px_12px_rgba(0,0,0,.85)]"
                          fallback={<h2 className="font-display text-2xl sm:text-3xl font-extrabold text-white leading-tight text-title-shadow">{cleanDisplayTitle(show.title)}</h2>}
                        />
                        <h2 className="sr-only">{cleanDisplayTitle(show.title)}</h2>
                      </div>
                    ) : (
                      <h2 className="font-display text-2xl sm:text-3xl font-extrabold text-white leading-tight text-title-shadow">
                        {cleanDisplayTitle(show.title)}
                      </h2>
                    )}
                  </div>
                </div>

                {/* CONTENT: SINOPSIS, GÉNEROS Y EPISODIOS */}
                <div className="details-body p-6 space-y-6 flex-1">

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

                  <div className="details-facts" aria-label="Información rápida">
                    <div><span>Formato</span><strong>{contentLabel(show.category)}</strong></div>
                    {show.year && <div><span>Estreno</span><strong>{show.year}</strong></div>}
                    {isMovie && (show.runtime_minutes || show.duration) && (
                      <div><span>Duración</span><strong>{show.runtime_minutes ? `${show.runtime_minutes} min` : show.duration}</strong></div>
                    )}
                    {!isMovie && episodes.length > 0 && <div><span>Temporadas</span><strong>{availableSeasons.length}</strong></div>}
                    {show.rating ? <div><span>Valoración</span><strong className="text-amber-300">★ {Number(show.rating).toFixed(1)}</strong></div> : null}
                  </div>

                  {/* SINOPSIS */}
                  <div className="space-y-1.5">
                    <h4 className="text-xs font-bold text-zinc-400 uppercase tracking-wider font-mono">
                      Sinopsis
                    </h4>
                    <p className="text-xs sm:text-sm text-zinc-300 leading-relaxed font-normal">
                      {cleanDescription(show.description, show.title) || 'Sin descripción disponible para esta obra.'}
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
                  {isMovie ? (
                    <div className="pt-4 flex flex-col items-center gap-3 pb-8">
                      <button
                        type="button"
                        onClick={() => onSelectEpisode(movieEpisode, cleanDisplayTitle(show.title))}
                        className="details-play group relative flex items-center justify-center gap-3 w-full sm:w-auto px-12 py-4 rounded-xl bg-amber-500 hover:bg-amber-400 text-black font-display font-bold text-base transition-all hover:scale-105 shadow-[0_0_20px_rgba(245,158,11,0.4)] cursor-pointer"
                      >
                        {isMovieCompleted ? (
                          <>
                            <RotateCcw size={20} className="stroke-[2.5]" />
                            Volver a ver película
                          </>
                        ) : moviePercent > 0 ? (
                          <>
                            <Play size={20} className="fill-black" />
                            Continuar película ({moviePercent}%)
                          </>
                        ) : (
                          <>
                            <Play size={20} className="fill-black" />
                            Reproducir película
                          </>
                        )}
                      </button>

                      {moviePercent > 0 && (
                        <div className="w-full sm:w-72 space-y-1">
                          <div className="flex justify-between text-[11px] font-mono text-zinc-400">
                            <span>{isMovieCompleted ? 'Completada' : 'Progreso de reproducción'}</span>
                            <span className={isMovieCompleted ? 'text-emerald-400 font-bold' : 'text-amber-400'}>
                              {moviePercent}%
                            </span>
                          </div>
                          <div className="h-1.5 w-full bg-zinc-800 rounded-full overflow-hidden">
                            <div
                              className={`h-full transition-all duration-300 ${
                                isMovieCompleted ? 'bg-emerald-500' : 'bg-amber-500'
                              }`}
                              style={{ width: `${moviePercent}%` }}
                            />
                          </div>
                        </div>
                      )}
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
                              <div ref={seasonMenuRef} className="details-season-picker relative mt-1">
                                <button
                                  type="button"
                                  aria-haspopup="listbox"
                                  aria-expanded={isSeasonMenuOpen}
                                  aria-label="Elegir temporada"
                                  onClick={() => setIsSeasonMenuOpen((open) => !open)}
                                  className="details-season-trigger"
                                >
                                  <span>Temporada {selectedSeason}</span>
                                  <ChevronDown size={14} aria-hidden="true" />
                                </button>
                                {isSeasonMenuOpen && (
                                  <div className="details-season-menu" role="listbox" aria-label="Temporadas disponibles">
                                    {availableSeasons.map((season) => (
                                      <button
                                        key={season}
                                        type="button"
                                        role="option"
                                        aria-selected={selectedSeason === season}
                                        onClick={() => {
                                          setSelectedSeason(season);
                                          setIsSeasonMenuOpen(false);
                                        }}
                                        className="details-season-option"
                                      >
                                        <span>Temporada {season}</span>
                                        <small>{seasonData.seasonsMap.get(season)?.length || 0} eps.</small>
                                      </button>
                                    ))}
                                  </div>
                                )}
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
                              aria-label="Buscar episodio"
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
                        <>
                          <div className="episode-grid grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5 pr-1">
                          {displayedEpisodes.map((ep) => {
                            const prog = episodeProgressMap.get(ep.id) || episodeProgressMap.get(`num_${ep.episode_number}`);
                            const percent = prog?.percent || 0;
                            const isCompleted = percent >= 85;
                            const isInProgress = percent > 0 && !isCompleted;

                            return (
                              <button
                                key={ep.id}
                                type="button"
                                onClick={() => onSelectEpisode(ep, cleanDisplayTitle(show.title))}
                                className={`episode-card group/ep relative w-full flex flex-col justify-between overflow-hidden rounded-xl p-3 text-left border transition-all shadow-sm ${
                                  isCompleted
                                    ? 'bg-zinc-900/50 border-emerald-500/30 hover:border-emerald-500/50 hover:bg-zinc-800/60'
                                    : isInProgress
                                      ? 'bg-zinc-900/80 border-amber-500/30 hover:border-amber-500/60 hover:bg-zinc-800/80'
                                      : 'bg-zinc-900/60 hover:bg-zinc-800/70 border-zinc-800/80 hover:border-zinc-700'
                                }`}
                              >
                                <div className="flex items-center justify-between gap-2 w-full pb-1">
                                  <div className="flex flex-col truncate pr-2">
                                    <span className="font-display text-xs font-semibold text-zinc-200 group-hover/ep:text-amber-400 truncate transition-colors">
                                      {displayEpisodeTitle(ep.title, ep.episode_number)}
                                    </span>
                                    <div className="flex items-center gap-2 mt-1">
                                      <span className="text-[11px] text-zinc-500 font-mono">
                                        Ep. {ep.episode_number}
                                      </span>

                                      {isCompleted && (
                                        <span className="inline-flex items-center gap-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 px-1.5 py-0.2 text-[10px] font-bold text-emerald-400">
                                          <Check size={10} strokeWidth={3} /> Visto
                                        </span>
                                      )}

                                      {isInProgress && (
                                        <span className="inline-flex items-center rounded bg-amber-500/15 border border-amber-500/30 px-1.5 py-0.2 text-[10px] font-semibold text-amber-400 font-mono">
                                          {percent}%
                                        </span>
                                      )}
                                    </div>
                                  </div>

                                  <span
                                    className={`episode-play flex h-8 w-8 items-center justify-center rounded-full transition-colors shrink-0 ${
                                      isCompleted
                                        ? 'bg-emerald-500/20 text-emerald-400 group-hover/ep:bg-emerald-500 group-hover/ep:text-black'
                                        : isInProgress
                                          ? 'bg-amber-500/20 text-amber-400 group-hover/ep:bg-amber-500 group-hover/ep:text-black'
                                          : 'bg-zinc-800 text-zinc-300 group-hover/ep:bg-amber-500 group-hover/ep:text-black'
                                    }`}
                                  >
                                    <Play size={13} className="ml-0.5 fill-current" />
                                  </span>
                                </div>

                                {/* BARRA DE PROGRESO INFERIOR */}
                                {percent > 0 && (
                                  <div className="absolute bottom-0 left-0 right-0 h-1 bg-zinc-800/80 overflow-hidden">
                                    <div
                                      className={`h-full transition-all duration-300 ${
                                        isCompleted ? 'bg-emerald-500' : 'bg-amber-500'
                                      }`}
                                      style={{ width: `${Math.max(5, percent)}%` }}
                                    />
                                  </div>
                                )}
                              </button>
                            );
                          })}
                          </div>
                          {filteredEpisodes.length > displayedEpisodes.length && (
                            <button
                              type="button"
                              className="episode-loadmore"
                              onClick={() => setVisibleEpisodeCount((count) => Math.min(count + (episodeSearch ? 50 : 12), filteredEpisodes.length))}
                            >
                              Mostrar más episodios <span>{displayedEpisodes.length} de {filteredEpisodes.length}</span>
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  )}

                  {(isLoadingRelated || relatedShows.length > 0) && (
                    <section className="details-related" aria-labelledby="details-related-title">
                      <div className="details-section-heading">
                        <div>
                          <span className="details-section-kicker"><Film size={13} /> Para continuar</span>
                          <h4 id="details-related-title">También podría gustarte</h4>
                        </div>
                        {!isLoadingRelated && <span>{relatedShows.length} títulos</span>}
                      </div>
                      {isLoadingRelated ? (
                        <div className="details-related-grid" aria-label="Cargando recomendaciones">
                          {Array.from({ length: 4 }, (_, index) => <div key={index} className="details-related-skeleton" />)}
                        </div>
                      ) : (
                        <div className="details-related-grid">
                          {relatedShows.map((related) => (
                            <MediaCard
                              key={related.id}
                              media={related}
                              imageLoading="lazy"
                              onSelectMedia={(item) => onSelectShow?.(item)}
                            />
                          ))}
                        </div>
                      )}
                    </section>
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
