// src/components/MediaDetailsModal.tsx
import React, { useEffect, useState, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Play, Loader2, AlertCircle, Search, Calendar, Star, Check, RotateCcw, ChevronDown, Film, Heart, Clock, ListPlus, Edit3, SkipForward, MoreHorizontal } from 'lucide-react';
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
import { useUserLists } from '../hooks/useUserLists';
import { useAuth } from '../contexts/AuthContext';
import { AddToListModal } from './AddToListModal';
import { isNativeLowCostPresentation, isNativeShell, nativeHaptic } from '../utils/runtime';

const LazyReportControl = React.lazy(() => import('./ReportControl'));

function parsePublicCatalogId(value: string): { kind: 'movie' | 'series' | 'anime'; tmdbId: number } | null {
  const match = /^tmdb-(movie|series|anime)-(\d+)$/.exec(value.trim());
  if (!match) return null;
  const tmdbId = Number(match[2]);
  return Number.isInteger(tmdbId) && tmdbId > 0
    ? { kind: match[1] as 'movie' | 'series' | 'anime', tmdbId }
    : null;
}

async function fetchDetailJson(url: string, init?: RequestInit): Promise<ShowDetail> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message = payload && typeof payload === 'object' && 'error' in payload
          ? String((payload as { error?: unknown }).error || '')
          : '';
        throw new Error(message || `No se pudo cargar la ficha (HTTP ${response.status}).`);
      }
      return payload as ShowDetail;
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise((resolve) => window.setTimeout(resolve, 350));
    } finally {
      window.clearTimeout(timeout);
    }
  }

  if (lastError instanceof Error && lastError.name === 'AbortError') {
    throw new Error('El servidor tardó demasiado en responder. Vuelve a intentarlo.');
  }
  if (lastError instanceof TypeError) {
    throw new Error('No se pudo conectar con MeriStream. Comprueba el túnel e inténtalo de nuevo.');
  }
  throw lastError instanceof Error ? lastError : new Error('No se pudo cargar la información del título.');
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
  const { user } = useAuth();
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
  const { isFavorite, isWatchlist, toggleFavorite, toggleWatchlist } = useUserLists();
  const [addToListModalOpen, setAddToListModalOpen] = useState(false);
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);
  const nativeShell = isNativeShell();
  const isFav = show ? isFavorite(show) : false;
  const isWatch = show ? isWatchlist(show) : false;

  useEffect(() => {
    if (!isOpen || !showId) return;

    setIsLoading(true);
    setError(null);
    setShow(null);
    setEpisodeSearch('');
    setSelectedSeason(1);
    setVisibleEpisodeCount(12);
    setIsSeasonMenuOpen(false);
    setMobileActionsOpen(false);
    setRelatedShows([]);
    setIsLoadingRelated(false);

    const publicIdentity = parsePublicCatalogId(showId);
    const detailUrl = publicIdentity
      ? `/api/v1/catalog/public/${publicIdentity.kind}/${publicIdentity.tmdbId}`
      : `/api/v1/shows/${encodeURIComponent(showId)}`;

    const preferences = getAppPreferences(userId);
    const personalKey = preferences.tmdbApiKeyEnabled ? preferences.tmdbApiKey.trim() : '';
    const requestInit = personalKey ? { headers: { 'X-TMDB-Personal-Key': personalKey } } : undefined;
    fetchDetailJson(detailUrl, requestInit)
      .then(async (localData) => {
        if (!publicIdentity && Number(localData.tmdb_id) > 0) {
          const rawKind = String(localData.category || localData.kind || '').toLowerCase();
          const publicKind = rawKind.includes('movie') || rawKind.includes('pel')
            ? 'movie'
            : rawKind.includes('anime')
              ? 'anime'
              : 'series';
          try {
            const localizedResponse = await fetch(`/api/v1/catalog/public/${publicKind}/${localData.tmdb_id}`, requestInit);
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
            // TMDB fallback
          }
        }
        return localData;
      })
      .then((data: ShowDetail) => {
        setShow(data);
        const img = data.backdrop_url || data.poster_url;
        if (img && !isNativeLowCostPresentation()) {
          extractDominantColor(img, data.title).then(setAccentRgb);
        } else {
          setAccentRgb([245, 158, 11]);
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setIsLoading(false));
  }, [isOpen, showId, userId]);

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
    const preferences = getAppPreferences(userId);
    const personalKey = preferences.tmdbApiKeyEnabled ? preferences.tmdbApiKey.trim() : '';
    setIsLoadingRelated(true);

    const loadRelated = () => {
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
    };

    const deferredId = nativeShell ? window.setTimeout(loadRelated, 700) : null;
    if (!nativeShell) loadRelated();

    return () => {
      if (deferredId !== null) window.clearTimeout(deferredId);
      controller.abort();
    };
  }, [isOpen, show, userId, nativeShell]);

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
    if (!watchProgress || !watchProgress.length) return map;

    const targetShowId = String(showId || '');
    const currentShowId = String(show?.id || '');
    const currentTmdbId = show?.tmdb_id ? String(show.tmdb_id) : '';
    const currentTitle = String(show?.title || '').toLowerCase().trim();

    for (const p of watchProgress) {
      const pShowId = String(p.showId || '');
      const pTitle = String(p.showTitle || '').toLowerCase().trim();

      const isMatch =
        (targetShowId && pShowId === targetShowId) ||
        (currentShowId && pShowId === currentShowId) ||
        (currentTmdbId && pShowId.includes(currentTmdbId)) ||
        (currentTitle && pTitle && pTitle === currentTitle);

      if (isMatch) {
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
  }, [watchProgress, showId, show?.id, show?.tmdb_id, show?.title]);

  const episodes = show?.episodes ? [...show.episodes].sort((a, b) => (a.episode_number || 0) - (b.episode_number || 0)) : [];

  const { currentPlaybackEpisode, nextPlaybackEpisode, isResumingCurrent } = useMemo(() => {
    if (!episodes || episodes.length === 0) {
      return { currentPlaybackEpisode: null, nextPlaybackEpisode: null, isResumingCurrent: false };
    }

    let inProgressEp: Episode | null = null;
    let lastCompletedIndex = -1;

    for (let i = 0; i < episodes.length; i++) {
      const ep = episodes[i];
      const prog = episodeProgressMap.get(ep.id) || episodeProgressMap.get(`num_${ep.episode_number}`);
      if (prog && prog.percent > 0) {
        if (prog.percent < 85) {
          inProgressEp = ep;
        } else {
          lastCompletedIndex = Math.max(lastCompletedIndex, i);
        }
      }
    }

    let currentEp: Episode = episodes[0];
    let isResume = false;

    if (inProgressEp) {
      currentEp = inProgressEp;
      isResume = true;
    } else if (lastCompletedIndex >= 0) {
      if (lastCompletedIndex + 1 < episodes.length) {
        currentEp = episodes[lastCompletedIndex + 1];
      } else {
        currentEp = episodes[lastCompletedIndex];
      }
    }

    const currentIdx = episodes.findIndex((e) => e.id === currentEp.id);
    let nextEp: Episode | null = null;
    if (currentIdx >= 0 && currentIdx + 1 < episodes.length) {
      nextEp = episodes[currentIdx + 1];
    } else if (episodes.length > 1) {
      nextEp = episodes[1];
    }

    return { currentPlaybackEpisode: currentEp, nextPlaybackEpisode: nextEp, isResumingCurrent: isResume };
  }, [episodes, episodeProgressMap]);

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

    const availableSeasons = Array.from(seasonsMap.keys()).sort((a, b) => a - b);
    return { seasonsMap, availableSeasons };
  }, [episodes, show?.title]);

  const { availableSeasons } = seasonData;

  useEffect(() => {
    if (availableSeasons.length > 0 && !availableSeasons.includes(selectedSeason)) {
      setSelectedSeason(availableSeasons[0]);
    }
  }, [availableSeasons, selectedSeason]);

  const filteredEpisodes = useMemo(() => {
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

  const headerBackdrop = heroBackdropUrl(show ?? {});
  const headerBackdropSrcSet = heroBackdropSrcSet(show ?? {});
  const hasWideHeader = Boolean((show as any)?.backdrop_path || show?.banner_url || show?.backdrop_url);
  const headerImage = headerBackdrop ?? show?.poster_url ?? undefined;

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

  const movieEpisode = episodes[0] || (show?.episodes && show.episodes[0]) || {
    id: show?.id || 'movie',
    title: show?.title || 'Película Completa',
    episode_number: 1,
    source_url: (show as any)?.source_url || show?.sources?.master_m3u8 || '',
  };
  const movieProgress = episodeProgressMap.get(movieEpisode.id) || episodeProgressMap.get('num_1') || (isMovie && episodeProgressMap.size > 0 ? Array.from(episodeProgressMap.values())[0] : undefined);
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
            initial={nativeShell ? false : { x: '100%' }}
            animate={{ x: 0 }}
            exit={nativeShell ? { opacity: 0 } : { x: '100%' }}
            transition={nativeShell ? { duration: 0.12 } : { type: 'spring', damping: 28, stiffness: 260 }}
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
                <div className="details-hero relative h-[65vh] min-h-[30rem] max-h-[48rem] sm:h-[68vh] md:h-[72vh] w-full shrink-0 overflow-hidden bg-zinc-950">
                  {headerImage && !hasWideHeader && (
                    <SmartImage
                      src={headerImage}
                      srcSet={headerBackdropSrcSet}
                      sizes="100vw"
                      alt=""
                      aria-hidden="true"
                      className="details-portrait-blur absolute inset-0 h-full w-full object-cover scale-110 blur-2xl brightness-[0.35]"
                    />
                  )}
                  {headerImage && (
                    <SmartImage
                      src={headerImage}
                      srcSet={headerBackdropSrcSet}
                      sizes="100vw"
                      alt={show.title}
                      className={`absolute inset-0 h-full w-full ${
                        hasWideHeader
                          ? 'object-cover filter brightness-90'
                          : 'object-contain object-top filter drop-shadow-lg'
                      }`}
                    />
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-zinc-950 via-zinc-950/70 to-transparent" />
                  <div
                    className="details-glow absolute inset-0 pointer-events-none opacity-40"
                    style={{
                      background: `radial-gradient(circle at 75% 30%, ${glowStyle} 0%, transparent 60%)`,
                    }}
                  />

                  {/* BOTTOM FLOATING INFO ON HEADER */}
                  <div className="details-hero-info absolute bottom-0 inset-x-0 pb-8 sm:pb-12 z-10">
                    <div className="w-full max-w-7xl mx-auto px-6 sm:px-10 lg:px-16 space-y-3 sm:space-y-4">
                      <div className="flex items-center gap-2 sm:gap-2.5 flex-wrap">
                        <span
                          className="details-category rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wider backdrop-blur-md shadow-sm"
                          style={{
                            backgroundColor: rgbToRgbaString(accentRgb, 0.18),
                            borderColor: rgbToRgbaString(accentRgb, 0.35),
                            borderWidth: '1px',
                            color: accentColor,
                          }}
                        >
                          {contentLabel(show.category)}
                        </span>

                        {show.year && (
                          <span className="text-xs sm:text-sm text-zinc-200 font-mono flex items-center gap-1.5 bg-black/60 px-3 py-1 rounded-full border border-white/10 backdrop-blur-md">
                            <Calendar size={13} className="text-zinc-400" /> {show.year}
                          </span>
                        )}

                        {show.rating && (
                          <span className="rounded-full bg-black/70 px-3 py-1 text-xs sm:text-sm font-bold text-amber-300 border border-amber-500/30 backdrop-blur-md flex items-center gap-1.5 shadow-sm">
                            <Star size={13} className="fill-amber-400 text-amber-400" />
                            {typeof show.rating === 'number' ? show.rating.toFixed(1) : show.rating}
                          </span>
                        )}

                        {genresList.map((genre, idx) => (
                          <span
                            key={idx}
                            className="rounded-full bg-black/50 hover:bg-black/70 border border-white/15 px-3 py-1 text-xs text-zinc-200 font-medium tracking-wide backdrop-blur-md transition-colors"
                          >
                            {genre}
                          </span>
                        ))}
                      </div>

                    {show.logo_url ? (
                      <div className="my-1 sm:my-2">
                        <SmartImage
                          src={show.logo_url}
                          alt={cleanDisplayTitle(show.title)}
                          className="details-title-logo max-h-16 sm:max-h-24 max-w-[min(84vw,28rem)] object-contain object-left drop-shadow-[0_4px_16px_rgba(0,0,0,.9)]"
                          fallback={<h2 className="font-display text-2xl sm:text-3xl md:text-4xl font-black text-white leading-tight tracking-tight text-title-shadow">{cleanDisplayTitle(show.title)}</h2>}
                        />
                        <h2 className="sr-only">{cleanDisplayTitle(show.title)}</h2>
                      </div>
                    ) : (
                      <h2 className="font-display text-2xl sm:text-3xl md:text-4xl font-black text-white leading-tight tracking-tight text-title-shadow my-1 sm:my-2">
                        {cleanDisplayTitle(show.title)}
                      </h2>
                    )}

                    <div className="details-hero-actions flex flex-wrap items-center gap-2.5 sm:gap-3 pt-2">
                      {isMovie && !hasNoSources && (
                        <button
                          type="button"
                          onClick={() => onSelectEpisode(movieEpisode, cleanDisplayTitle(show.title))}
                          className="details-hero-play"
                          aria-label={`${moviePercent > 0 ? 'Continuar' : 'Reproducir'} ${cleanDisplayTitle(show.title)}`}
                        >
                          {isMovieCompleted ? <RotateCcw size={16} /> : <Play size={16} className="fill-current" />}
                          <span>{isMovieCompleted ? 'Volver a ver' : moviePercent > 0 ? 'Continuar' : 'Reproducir'}</span>
                        </button>
                      )}

                      {!isMovie && !hasNoSources && currentPlaybackEpisode && (
                        <button
                          type="button"
                          onClick={() => onSelectEpisode(currentPlaybackEpisode, cleanDisplayTitle(show.title))}
                          className="details-hero-play"
                          aria-label={`${isResumingCurrent ? 'Continuar' : 'Ver'} Episodio ${currentPlaybackEpisode.episode_number}`}
                        >
                          <Play size={16} className="fill-current" />
                          <span>
                            {isResumingCurrent
                              ? `Continuar Ep. ${currentPlaybackEpisode.episode_number}`
                              : currentPlaybackEpisode.episode_number && currentPlaybackEpisode.episode_number > 1
                                ? `Ver Ep. ${currentPlaybackEpisode.episode_number}`
                                : 'Ver ahora'}
                          </span>
                        </button>
                      )}

                      {/* BOTÓN EXPLÍCITO DE SIGUIENTE EPISODIO SIEMPRE VISIBLE */}
                      {!isMovie && !hasNoSources && nextPlaybackEpisode && (
                        <button
                          type="button"
                          onClick={() => onSelectEpisode(nextPlaybackEpisode, cleanDisplayTitle(show.title))}
                          data-details-secondary-action
                          className="flex items-center gap-2 px-3.5 sm:px-4 py-2.5 rounded-xl text-xs sm:text-sm font-bold bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 backdrop-blur-md transition shadow-md shadow-amber-500/10 hover:scale-[1.02] active:scale-[0.98]"
                          title={`Reproducir siguiente episodio: ${displayEpisodeTitle(nextPlaybackEpisode.title, nextPlaybackEpisode.episode_number)}`}
                          aria-label={`Reproducir siguiente episodio (${nextPlaybackEpisode.episode_number})`}
                        >
                          <SkipForward size={16} className="fill-current text-amber-400" />
                          <span>Siguiente ep. ({nextPlaybackEpisode.episode_number})</span>
                        </button>
                      )}

                      {/* FAVORITOS */}
                      <button
                        type="button"
                        onClick={() => toggleFavorite(show)}
                        data-details-secondary-action
                        className={`flex items-center gap-2 px-3.5 sm:px-4 py-2.5 rounded-xl text-xs sm:text-sm font-semibold backdrop-blur-md transition border ${
                          isFav
                            ? 'bg-rose-500/25 border-rose-500/60 text-rose-300 shadow-md shadow-rose-500/10'
                            : 'bg-black/50 border-white/10 text-zinc-300 hover:text-white hover:bg-black/70'
                        }`}
                        title={isFav ? 'Quitar de Favoritos' : 'Añadir a Favoritos'}
                      >
                        <Heart size={15} className={isFav ? 'fill-current text-rose-400' : 'text-zinc-400'} />
                        <span>{isFav ? 'En favoritos' : 'Favorito'}</span>
                      </button>

                      {/* VER MÁS TARDE */}
                      <button
                        type="button"
                        onClick={() => toggleWatchlist(show)}
                        data-details-secondary-action
                        className={`flex items-center gap-2 px-3.5 sm:px-4 py-2.5 rounded-xl text-xs sm:text-sm font-semibold backdrop-blur-md transition border ${
                          isWatch
                            ? 'bg-amber-500/25 border-amber-500/60 text-amber-300 shadow-md shadow-amber-500/10'
                            : 'bg-black/50 border-white/10 text-zinc-300 hover:text-white hover:bg-black/70'
                        }`}
                        title={isWatch ? 'Quitar de Ver más tarde' : 'Guardar para ver más tarde'}
                      >
                        <Clock size={15} className={isWatch ? 'text-amber-400' : 'text-zinc-400'} />
                        <span>{isWatch ? 'Guardado' : 'Ver más tarde'}</span>
                      </button>

                      {/* AÑADIR A OTRA LISTA */}
                      <button
                        type="button"
                        onClick={() => setAddToListModalOpen(true)}
                        data-details-secondary-action
                        className="flex items-center gap-2 px-3.5 sm:px-4 py-2.5 rounded-xl text-xs sm:text-sm font-semibold bg-black/50 hover:bg-black/70 text-zinc-300 hover:text-white border border-white/10 backdrop-blur-md transition"
                        title="Guardar en una lista personalizada"
                      >
                        <ListPlus size={15} />
                        <span>Listas</span>
                      </button>

                      {/* BOTÓN DE EDITAR PARA ADMINISTRADORES */}
                      {user?.is_admin && (
                        <button
                          type="button"
                          data-details-secondary-action
                          onClick={() => {
                            window.location.assign(`/admin?show_id=${encodeURIComponent(String(show.id || ''))}&tmdb_id=${encodeURIComponent(String(show.tmdb_id || ''))}&kind=${encodeURIComponent(String(show.kind || show.category || ''))}&title=${encodeURIComponent(String(show.title || ''))}`);
                          }}
                          className="flex items-center gap-2 px-3.5 sm:px-4 py-2.5 rounded-xl text-xs sm:text-sm font-semibold bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 backdrop-blur-md transition shadow-md shadow-amber-500/5"
                          title="Abrir editor de esta obra en el Panel de Administración"
                        >
                          <Edit3 size={15} />
                          <span>Editar obra</span>
                        </button>
                      )}

                      {!nativeShell && (
                        <div data-details-secondary-action>
                          <React.Suspense fallback={null}>
                            <LazyReportControl
                              title={cleanDisplayTitle(show.title)}
                              showId={show.id}
                              tmdbId={Number(show.tmdb_id) > 0 ? Number(show.tmdb_id) : null}
                              kind={show.kind || show.category}
                              className="bg-black/50"
                            />
                          </React.Suspense>
                        </div>
                      )}

                      <button
                        type="button"
                        className="native-details-more-trigger hidden"
                        onClick={() => {
                          nativeHaptic();
                          setMobileActionsOpen(true);
                        }}
                        aria-label="Más acciones"
                      >
                        <MoreHorizontal size={18} />
                        <span>Más</span>
                      </button>

                      {mobileActionsOpen && (
                        <>
                          <button
                            type="button"
                            className="native-details-actions-backdrop hidden"
                            aria-label="Cerrar acciones"
                            onClick={() => setMobileActionsOpen(false)}
                          />
                          <div className="native-details-actions-sheet hidden" role="dialog" aria-label="Acciones de la obra">
                            <div className="native-details-actions-handle" />
                            {!isMovie && !hasNoSources && nextPlaybackEpisode && (
                              <button
                                type="button"
                                className="native-details-action"
                                onClick={() => {
                                  setMobileActionsOpen(false);
                                  onSelectEpisode(nextPlaybackEpisode, cleanDisplayTitle(show.title));
                                }}
                              >
                                <SkipForward size={17} />
                                <span>Siguiente episodio</span>
                              </button>
                            )}
                            <button type="button" className="native-details-action" onClick={() => { nativeHaptic(); toggleFavorite(show); }}>
                              <Heart size={17} className={isFav ? 'fill-current text-rose-400' : ''} />
                              <span>{isFav ? 'Quitar de favoritos' : 'Añadir a favoritos'}</span>
                            </button>
                            <button type="button" className="native-details-action" onClick={() => { nativeHaptic(); toggleWatchlist(show); }}>
                              <Clock size={17} />
                              <span>{isWatch ? 'Quitar de ver más tarde' : 'Ver más tarde'}</span>
                            </button>
                            <button type="button" className="native-details-action" onClick={() => { setMobileActionsOpen(false); setAddToListModalOpen(true); }}>
                              <ListPlus size={17} />
                              <span>Guardar en una lista</span>
                            </button>
                            {user?.is_admin && (
                              <button
                                type="button"
                                className="native-details-action"
                                onClick={() => window.location.assign(`/admin?show_id=${encodeURIComponent(String(show.id || ''))}&tmdb_id=${encodeURIComponent(String(show.tmdb_id || ''))}&kind=${encodeURIComponent(String(show.kind || show.category || ''))}&title=${encodeURIComponent(String(show.title || ''))}`)}
                              >
                                <Edit3 size={17} />
                                <span>Editar obra</span>
                              </button>
                            )}
                            <React.Suspense fallback={<div className="native-details-action opacity-60">Cargando reporte…</div>}>
                              <LazyReportControl
                                title={cleanDisplayTitle(show.title)}
                                showId={show.id}
                                tmdbId={Number(show.tmdb_id) > 0 ? Number(show.tmdb_id) : null}
                                kind={show.kind || show.category}
                                className="native-details-action"
                              />
                            </React.Suspense>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </div>

                {/* CONTENT: SINOPSIS, GÉNEROS Y EPISODIOS */}
                <div className="details-body py-8 sm:py-12 flex-1">
                  <div className="w-full max-w-7xl mx-auto px-6 sm:px-10 lg:px-16 space-y-8">

                    <div className="details-facts" aria-label="Información rápida">
                      <div><span>Formato</span><strong>{contentLabel(show.category)}</strong></div>
                      {show.year && <div><span>Estreno</span><strong>{show.year}</strong></div>}
                      {genresList.length > 0 && <div><span>Géneros</span><strong>{genresList.join(', ')}</strong></div>}
                      {isMovie && (show.runtime_minutes || show.duration) && (
                        <div><span>Duración</span><strong>{show.runtime_minutes ? `${show.runtime_minutes} min` : show.duration}</strong></div>
                      )}
                      {!isMovie && episodes.length > 0 && <div><span>Temporadas</span><strong>{availableSeasons.length}</strong></div>}
                      {show.rating ? <div><span>Valoración</span><strong className="text-amber-300">★ {Number(show.rating).toFixed(1)}</strong></div> : null}
                    </div>

                  {/* SINOPSIS */}
                  <div className="space-y-2.5">
                    <h4 className="text-xs font-bold text-zinc-400 uppercase tracking-widest font-mono">
                      Sinopsis
                    </h4>
                    <p className="text-sm sm:text-[15px] text-zinc-300/90 leading-relaxed sm:leading-loose font-normal max-w-3xl">
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

                  {/* Reportar también queda disponible cuando una ficha aún no
                      tiene fuentes, justo el caso donde más útil resulta. */}
                  {!nativeShell && (!isMovie || hasNoSources) && (
                    <div className="flex justify-end">
                      <React.Suspense fallback={null}>
                        <LazyReportControl
                          title={cleanDisplayTitle(show.title)}
                          showId={show.id}
                          tmdbId={Number(show.tmdb_id) > 0 ? Number(show.tmdb_id) : null}
                          kind={show.kind || show.category}
                          className="bg-black/50"
                        />
                      </React.Suspense>
                    </div>
                  )}

                  {/* BOTÓN DE REPRODUCIR PARA PELÍCULAS O LISTA DE EPISODIOS */}
                  {isMovie ? (
                    moviePercent > 0 && (
                      <div className="details-movie-progress w-full sm:w-72 space-y-2 pt-1">
                        <div className="flex justify-between text-xs font-mono text-zinc-400">
                          <span>{isMovieCompleted ? 'Completada' : 'Progreso de reproducción'}</span>
                          <span className={isMovieCompleted ? 'text-emerald-400 font-bold' : 'text-amber-400 font-semibold'}>
                            {moviePercent}%
                          </span>
                        </div>
                        <div className="h-2 w-full bg-zinc-800 rounded-full overflow-hidden">
                          <div
                            className={`h-full transition-all duration-300 ${
                              isMovieCompleted ? 'bg-emerald-500' : 'bg-amber-500'
                            }`}
                            style={{ width: `${moviePercent}%` }}
                          />
                        </div>
                      </div>
                    )
                  ) : (
                    <div className="space-y-5 pt-2">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3.5 border-b border-zinc-800/80 pb-4">
                        <div className="flex items-center gap-2">
                          <div className="flex flex-col gap-2">
                            <h4 className="font-display text-sm sm:text-base font-bold text-white tracking-tight">
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
                              size={14}
                              className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none"
                            />
                            <input
                              type="text"
                              value={episodeSearch}
                              onChange={(e) => setEpisodeSearch(e.target.value)}
                              placeholder="Buscar nº o título..."
                              aria-label="Buscar episodio"
                              className="rounded-xl bg-zinc-900/90 border border-zinc-800 text-xs sm:text-sm text-zinc-200 placeholder-zinc-500 pl-9 pr-3.5 py-2 focus:border-amber-500/60 focus:outline-none w-full sm:w-52 font-normal shadow-inner"
                            />
                          </div>
                        )}
                      </div>

                      {filteredEpisodes.length === 0 ? (
                        <div className="text-center py-12 text-xs sm:text-sm text-zinc-500 font-mono">
                          No se encontraron episodios {episodeSearch ? `que coincidan con "${episodeSearch}"` : 'registrados'}.
                        </div>
                      ) : (
                        <>
                          <div className="episode-grid grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 sm:gap-3.5 pr-1">
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
                                className={`episode-card group/ep relative w-full flex flex-col justify-between overflow-hidden rounded-xl p-3.5 sm:p-4 text-left border transition-all shadow-sm ${
                                  isCompleted
                                    ? 'bg-zinc-900/50 border-emerald-500/30 hover:border-emerald-500/50 hover:bg-zinc-800/60'
                                    : isInProgress
                                      ? 'bg-zinc-900/80 border-amber-500/30 hover:border-amber-500/60 hover:bg-zinc-800/80'
                                      : 'bg-zinc-900/60 hover:bg-zinc-800/70 border-zinc-800/80 hover:border-zinc-700'
                                }`}
                              >
                                <div className="flex items-center justify-between gap-2.5 w-full pb-1">
                                  <div className="flex flex-col truncate pr-2">
                                    <span className="font-display text-xs sm:text-sm font-semibold text-zinc-200 group-hover/ep:text-amber-400 truncate transition-colors leading-snug">
                                      {displayEpisodeTitle(ep.title, ep.episode_number)}
                                    </span>
                                    <div className="flex items-center gap-2.5 mt-1.5">
                                      <span className="text-[11px] sm:text-xs text-zinc-400 font-mono">
                                        Ep. {ep.episode_number}
                                      </span>

                                      {isCompleted && (
                                        <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 text-[10px] font-bold text-emerald-400">
                                          <Check size={11} strokeWidth={3} /> Visto
                                        </span>
                                      )}

                                      {isInProgress && (
                                        <span className="inline-flex items-center rounded-md bg-amber-500/15 border border-amber-500/30 px-2 py-0.5 text-[10px] font-semibold text-amber-400 font-mono">
                                          {percent}%
                                        </span>
                                      )}
                                    </div>
                                  </div>

                                  <span
                                    className={`episode-play flex h-9 w-9 items-center justify-center rounded-full transition-colors shrink-0 ${
                                      isCompleted
                                        ? 'bg-emerald-500/20 text-emerald-400 group-hover/ep:bg-emerald-500 group-hover/ep:text-black'
                                        : isInProgress
                                          ? 'bg-amber-500/20 text-amber-400 group-hover/ep:bg-amber-500 group-hover/ep:text-black'
                                          : 'bg-zinc-800 text-zinc-300 group-hover/ep:bg-amber-500 group-hover/ep:text-black'
                                    }`}
                                  >
                                    <Play size={14} className="ml-0.5 fill-current" />
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
              </div>
            )}
          </motion.div>
        </div>
      )}
      <AddToListModal
        isOpen={addToListModalOpen}
        onClose={() => setAddToListModalOpen(false)}
        show={show}
      />
    </AnimatePresence>
  );
};
