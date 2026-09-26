import React, { useRef, useMemo } from 'react';
import { Play, ChevronLeft, ChevronRight, X, Sparkles, Film } from 'lucide-react';
import { rgbToRgbaString } from '../utils/colorExtractor';
import { SmartImage } from './SmartImage';
import { sizedImageUrl } from '../utils/imageSizes';
import { isNativeLowCostPresentation } from '../utils/runtime';
import type { Episode, Show } from '../types';

export interface WatchProgress {
  showId: string;
  showTitle: string;
  showPoster?: string;
  episodeId: string;
  episodeNumber: number;
  episodeTitle: string;
  progressPercent: number; // e.g. 45 for 45%
  currentTime?: number;
  duration?: number;
  lastWatchedAt: number;
  isMovie?: boolean;
}

/** Nunca mostrar "undefined" en tarjetas (#2): fallback al número de episodio. */
function safeTitle(title: string | undefined, fallbackNumber: number): string {
  const t = (title || '').trim();
  if (t && !/^undefined$/i.test(t) && !/^null$/i.test(t)) return t;
  return fallbackNumber != null && fallbackNumber > 0 ? `Episodio ${fallbackNumber}` : 'Episodio';
}

interface ContinueWatchingProps {
  items: WatchProgress[];
  shows?: Show[];
  onPlayEpisode: (showId: string, episode: Episode, showTitle: string) => void;
  onSelectShow?: (showId: string) => void;
  onRemoveItem?: (episodeId: string, showId?: string) => void;
}

interface DisplayCardItem {
  showId: string;
  showTitle: string;
  showPoster?: string;
  episodeId: string;
  watchedEpisodeId?: string;
  episodeNumber: number;
  episodeTitle: string;
  progressPercent: number;
  currentTime?: number;
  duration?: number;
  lastWatchedAt: number;
  isMovie: boolean;
  isNextEpisode?: boolean;
  isCompleted?: boolean;
}

export const ContinueWatching: React.FC<ContinueWatchingProps> = ({
  items,
  shows = [],
  onPlayEpisode,
  onSelectShow,
  onRemoveItem,
}) => {
  const rowRef = useRef<HTMLDivElement>(null);
  const lowCostPresentation = isNativeLowCostPresentation();

  const handleScroll = (direction: 'left' | 'right') => {
    if (rowRef.current) {
      const { scrollLeft, clientWidth } = rowRef.current;
      const scrollAmount = clientWidth * 0.75;
      rowRef.current.scrollTo({
        left: direction === 'left' ? scrollLeft - scrollAmount : scrollLeft + scrollAmount,
        behavior: 'smooth',
      });
    }
  };

  // ── DEDUPLICACIÓN POR OBRA Y AVANCE INTELIGENTE DE EPISODIOS ───────────
  // Agrupa por showId para mostrar solo 1 tarjeta por serie/película.
  // Si el último episodio se completó (>85%), avanza al siguiente episodio disponible.
  const displayItems = useMemo<DisplayCardItem[]>(() => {
    if (!items || items.length === 0) return [];

    const showMap = new Map<string, Show>();
    shows.forEach((s) => showMap.set(s.id, s));

    // Agrupar entradas de watch progress por showId
    const groups = new Map<string, WatchProgress[]>();
    items.forEach((it) => {
      if (!it.showId) return;
      if (!groups.has(it.showId)) groups.set(it.showId, []);
      groups.get(it.showId)!.push(it);
    });

    const result: DisplayCardItem[] = [];

    for (const [showId, group] of groups.entries()) {
      // Ordenar por lastWatchedAt descendente
      group.sort((a, b) => (b.lastWatchedAt || 0) - (a.lastWatchedAt || 0));
      const latest = group[0];
      const show = showMap.get(showId);

      const isMovie = Boolean(
        latest.isMovie ||
        show?.kind === 'movie' ||
        (show as any)?.content_type === 'movie' ||
        ['pelicula', 'película', 'peliculas', 'películas', 'movie', 'movies', 'cine'].includes(
          (show?.category || '').toLowerCase().trim()
        ) ||
        (show?.episodes && show.episodes.length === 1 && !/episodio|capitulo|capítulo/i.test(show.episodes[0].title))
      );

      const percent = Math.min(100, Math.max(0, Math.round(latest.progressPercent || 0)));

      if (isMovie) {
        // Para películas terminadas (>90%), no saturar la fila activa de continuar viendo
        if (percent >= 90) continue;

        result.push({
          showId: latest.showId,
          showTitle: latest.showTitle || show?.title || 'Película',
          showPoster: latest.showPoster || show?.backdrop_url || show?.poster_url || undefined,
          episodeId: latest.episodeId,
          watchedEpisodeId: latest.episodeId,
          episodeNumber: 1,
          episodeTitle: latest.showTitle || 'Película',
          progressPercent: percent,
          currentTime: latest.currentTime,
          duration: latest.duration,
          lastWatchedAt: latest.lastWatchedAt,
          isMovie: true,
        });
      } else {
        // Es una Serie / Anime
        const allEpisodes = (show?.episodes ? [...show.episodes] : []).sort(
          (a, b) => (a.episode_number || 0) - (b.episode_number || 0)
        );

        if (percent >= 85) {
          // El episodio actual está completado. Buscar el siguiente episodio disponible
          let nextEp: Episode | undefined;
          if (allEpisodes.length > 0) {
            const currentIdx = allEpisodes.findIndex((e) => e.id === latest.episodeId || e.episode_number === latest.episodeNumber);
            if (currentIdx !== -1 && currentIdx + 1 < allEpisodes.length) {
              nextEp = allEpisodes[currentIdx + 1];
            } else if (currentIdx === -1) {
              // Buscar por número
              nextEp = allEpisodes.find((e) => (e.episode_number || 0) === (latest.episodeNumber || 1) + 1);
            }
          }

          if (nextEp) {
            // Mostrar tarjeta lista para reproducir el siguiente episodio
            result.push({
              showId: latest.showId,
              showTitle: latest.showTitle || show?.title || 'Serie',
              showPoster: latest.showPoster || show?.backdrop_url || show?.poster_url || undefined,
              episodeId: nextEp.id,
              watchedEpisodeId: latest.episodeId,
              episodeNumber: nextEp.episode_number || (latest.episodeNumber + 1),
              episodeTitle: nextEp.title || `Episodio ${nextEp.episode_number || (latest.episodeNumber + 1)}`,
              progressPercent: 0,
              currentTime: 0,
              duration: 0,
              lastWatchedAt: latest.lastWatchedAt,
              isMovie: false,
              isNextEpisode: true,
            });
          } else if (allEpisodes.length === 0 && latest.episodeNumber && percent < 95) {
            // Si la lista de episodios no está cargada y no superó el 95%, calcular siguiente
            const nextNum = latest.episodeNumber + 1;
            result.push({
              showId: latest.showId,
              showTitle: latest.showTitle || show?.title || 'Serie',
              showPoster: latest.showPoster || show?.backdrop_url || show?.poster_url || undefined,
              episodeId: `${latest.showId}-s1-e${nextNum}`,
              watchedEpisodeId: latest.episodeId,
              episodeNumber: nextNum,
              episodeTitle: `Episodio ${nextNum}`,
              progressPercent: 0,
              currentTime: 0,
              duration: 0,
              lastWatchedAt: latest.lastWatchedAt,
              isMovie: false,
              isNextEpisode: true,
            });
          }
          // Si no hay más episodios disponibles (serie completada), no muestra tarjeta fantasma.
        } else {
          // Episodio en progreso (<85%)
          result.push({
            showId: latest.showId,
            showTitle: latest.showTitle || show?.title || 'Serie',
            showPoster: latest.showPoster || show?.backdrop_url || show?.poster_url || undefined,
            episodeId: latest.episodeId,
            watchedEpisodeId: latest.episodeId,
            episodeNumber: latest.episodeNumber || 1,
            episodeTitle: latest.episodeTitle || `Episodio ${latest.episodeNumber || 1}`,
            progressPercent: percent,
            currentTime: latest.currentTime,
            duration: latest.duration,
            lastWatchedAt: latest.lastWatchedAt,
            isMovie: false,
          });
        }
      }
    }

    // Ordenar todas las obras por última interacción
    return result.sort((a, b) => b.lastWatchedAt - a.lastWatchedAt).slice(0, 15);
  }, [items, shows]);

  if (displayItems.length === 0) return null;

  return (
    <section className="continue-section space-y-3" style={{ contentVisibility: 'auto', containIntrinsicSize: '0 220px' }}>
      <div className="flex items-center justify-between">
        <h3 className="font-display text-lg sm:text-xl font-bold text-white tracking-tight">
          Seguir Viendo
        </h3>
        <span className="text-xs text-zinc-500 font-mono">
          {displayItems.length} {displayItems.length === 1 ? 'obra en curso' : 'obras en curso'}
        </span>
      </div>

      <div className="group/row relative">
        {/* BOTÓN SCROLL IZQUIERDA */}
        <button
          type="button"
          onClick={() => handleScroll('left')}
          aria-label="Desplazar a la izquierda"
          className="continue-arrow absolute left-0 top-1/2 -translate-y-1/2 z-20 hidden group-hover/row:flex h-12 w-10 items-center justify-center rounded-r-xl bg-zinc-950/90 text-zinc-200 backdrop-blur-md border-r border-y border-zinc-800 transition-all hover:bg-amber-500 hover:text-black hover:w-11 shadow-2xl"
        >
          <ChevronLeft size={22} />
        </button>

        {/* CONTENEDOR CARRUSEL */}
        <div
          ref={rowRef}
          className="continue-rail flex gap-4 overflow-x-auto pb-4 pt-1 px-1 scrollbar-none scroll-smooth items-stretch"
        >
          {displayItems.map((item) => (
            <div key={`${item.showId}-${item.episodeId}`} className="w-64 sm:w-72 shrink-0">
              <ContinueWatchingCard
                item={item}
                lowCostPresentation={lowCostPresentation}
                onPlay={() => {
                  const ep: Episode = {
                    id: item.episodeId,
                    show_id: item.showId,
                    title: item.isMovie
                      ? item.showTitle
                      : safeTitle(item.episodeTitle, item.episodeNumber),
                    episode_number: item.episodeNumber,
                    created_at: new Date().toISOString(),
                  };
                  onPlayEpisode(
                    item.showId,
                    ep,
                    safeTitle(item.showTitle, 0) === 'Episodio'
                      ? item.showTitle || 'Contenido'
                      : item.showTitle
                  );
                }}
                onOpenDetails={() => onSelectShow && onSelectShow(item.showId)}
                onRemove={() => onRemoveItem && onRemoveItem(item.watchedEpisodeId || item.episodeId, item.showId)}
              />
            </div>
          ))}
        </div>

        {/* BOTÓN SCROLL DERECHA */}
        <button
          type="button"
          onClick={() => handleScroll('right')}
          aria-label="Desplazar a la derecha"
          className="continue-arrow absolute right-0 top-1/2 -translate-y-1/2 z-20 hidden group-hover/row:flex h-12 w-10 items-center justify-center rounded-l-xl bg-zinc-950/90 text-zinc-200 backdrop-blur-md border-l border-y border-zinc-800 transition-all hover:bg-amber-500 hover:text-black hover:w-11 shadow-2xl"
        >
          <ChevronRight size={22} />
        </button>
      </div>
    </section>
  );
};

interface ContinueWatchingCardProps {
  item: DisplayCardItem;
  onPlay: () => void;
  onOpenDetails: () => void;
  onRemove?: () => void;
  lowCostPresentation?: boolean;
}

const ContinueWatchingCard: React.FC<ContinueWatchingCardProps> = ({
  item,
  onPlay,
  onOpenDetails,
  onRemove,
  lowCostPresentation = false,
}) => {
  const accentRgb: [number, number, number] = [245, 158, 11];
  const accentColor = rgbToRgbaString(accentRgb, 1);

  return (
    <div
      className="continue-card group/cw relative flex flex-col overflow-hidden rounded-xl bg-zinc-900 border border-zinc-800 hover:border-zinc-700 transition-all duration-200 cursor-pointer select-none"
      onClick={(event) => {
        if ((event.target as HTMLElement | null)?.closest('button')) return;
        onPlay();
      }}
    >
      {/* 16:9 HORIZONTAL THUMBNAIL */}
      <div className="relative aspect-[16/9] w-full overflow-hidden bg-zinc-950">
        {item.showPoster ? (
          <SmartImage
            src={sizedImageUrl(item.showPoster, lowCostPresentation ? 'w500' : 'w780') || item.showPoster}
            alt={item.showTitle || 'Vista previa'}
            className="h-full w-full object-cover object-center transition-transform duration-300 ease-out group-hover/cw:scale-105"
            fallback={
              <div className="h-full w-full bg-zinc-950 flex items-center justify-center text-zinc-600 text-xs">
                Sin Vista Previa
              </div>
            }
          />
        ) : (
          <div className="h-full w-full bg-zinc-950 flex items-center justify-center text-zinc-600 text-xs">
            Sin Vista Previa
          </div>
        )}

        <div className="absolute inset-0 bg-gradient-to-t from-zinc-950/80 via-transparent to-transparent" />

        {/* BOTÓN DE DESCARTE (X) EN HOVER */}
        {onRemove && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            title="Quitar de seguir viendo"
            aria-label="Quitar de seguir viendo"
            className="continue-remove absolute top-2 right-2 z-20 flex h-6 w-6 items-center justify-center rounded-full bg-black/70 text-zinc-400 hover:text-white hover:bg-rose-600/90 border border-zinc-700/50 backdrop-blur-md opacity-0 group-hover/cw:opacity-100 transition-all shadow-md"
          >
            <X size={12} />
          </button>
        )}

        {/* HOVER PLAY BUTTON */}
        <button type="button" onClick={onPlay} aria-label={`Continuar ${item.showTitle}`} className="continue-play absolute inset-0 bg-black/30 opacity-0 group-hover/cw:opacity-100 transition-opacity duration-200 flex items-center justify-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-amber-500 text-black shadow-xl group-hover/cw:scale-110 transition-transform">
            <Play size={18} className="ml-0.5 fill-black text-black" />
          </span>
        </button>

        {/* BADGE SUPERIOR IZQUIERDO: PELÍCULA / SIGUIENTE / EPISODIO */}
        <div className="absolute top-2 left-2 z-10 pointer-events-none">
          {item.isMovie ? (
            <span className="inline-flex items-center gap-1 rounded bg-black/80 px-2 py-0.5 text-[10px] font-mono font-semibold text-amber-300 border border-amber-500/30 backdrop-blur-sm shadow-sm">
              <Film size={10} /> Película
            </span>
          ) : item.isNextEpisode ? (
            <span className="inline-flex items-center gap-1 rounded bg-amber-500/90 px-2 py-0.5 text-[10px] font-mono font-bold text-black border border-amber-400 shadow-md">
              <Sparkles size={10} /> Ep. {item.episodeNumber}
            </span>
          ) : (
            <span className="rounded bg-black/80 px-2 py-0.5 text-[10px] font-mono font-semibold text-zinc-200 border border-zinc-800 backdrop-blur-sm shadow-sm">
              Ep. {item.episodeNumber}
            </span>
          )}
        </div>

        {/* BARRA DE PROGRESO INFERIOR */}
        <div className="absolute bottom-0 left-0 right-0 h-1 bg-zinc-800 overflow-hidden">
          <div
            className="continue-progress h-full transition-all duration-300"
            style={{
              width: item.isNextEpisode ? '0%' : `${Math.max(5, Math.min(100, item.progressPercent))}%`,
              backgroundColor: accentColor,
            }}
          />
        </div>
      </div>

      {/* METADATOS INFERIORES */}
      <div className="p-3 space-y-0.5">
        <div className="flex items-center justify-between text-xs">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenDetails();
            }}
            className="continue-details font-medium text-zinc-400 hover:text-zinc-200 truncate max-w-[70%] text-[11px] text-left"
          >
            {item.showTitle || 'Contenido'}
          </button>
          <span className="text-[10px] text-zinc-500 font-mono">
            {item.isNextEpisode ? 'Siguiente' : `${item.progressPercent}%`}
          </span>
        </div>
        <h4 onClick={onPlay} className="font-display text-xs sm:text-sm font-semibold text-zinc-100 group-hover/cw:text-amber-400 truncate transition-colors">
          {item.isMovie
            ? item.showTitle
            : item.isNextEpisode
              ? `Siguiente: ${safeTitle(item.episodeTitle, item.episodeNumber)}`
              : safeTitle(item.episodeTitle, item.episodeNumber)}
        </h4>
      </div>
    </div>
  );
};
