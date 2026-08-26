// src/components/MediaCard.tsx
import React, { memo } from 'react';
import { Play, Star, Tv } from 'lucide-react';
import type { Show } from '../types';

interface MediaCardProps {
  media: Show;
  onSelectMedia?: (media: Show) => void;
  onHover?: (media: Show) => void;
  isNew?: boolean;
}

// Bolt Performance: Memoized to prevent re-rendering identical cards on parent state changes
export const MediaCard: React.FC<MediaCardProps> = memo(({
  media,
  onSelectMedia,
  onHover,
}) => {
  const poster = media.poster_url || media.banner_url || media.backdrop_url;

  // Primary genre formatted
  const getPrimaryGenre = (): string => {
    if (!media.genres) return media.category || 'Anime';
    if (Array.isArray(media.genres)) return media.genres[0] || 'Anime';
    if (typeof media.genres === 'string') {
      const split = media.genres.split(',')[0];
      return split ? split.trim() : (media.category || 'Anime');
    }
    return media.category || 'Anime';
  };

  return (
    <article
      id={`card-${media.id}`}
      onClick={() => onSelectMedia && onSelectMedia(media)}
      onMouseEnter={() => onHover && onHover(media)}
      className="group/card relative flex flex-col cursor-pointer select-none text-left w-full"
    >
      {/* POSTER CONTAINER WITH CLEAN ELEVATION */}
      <div className="relative aspect-[2/3] w-full overflow-hidden rounded-xl bg-zinc-900 border border-zinc-800 shadow-sm transition-all duration-300 group-hover/card:border-zinc-700">
        {poster ? (
          <img
            src={poster}
            alt={media.title}
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-300 ease-out group-hover/card:scale-105"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-zinc-600 bg-zinc-950 p-3 text-center">
            <Tv size={28} className="text-zinc-600" />
            <span className="text-[11px] font-medium text-zinc-500">Sin Portada</span>
          </div>
        )}

        {/* SUBTLE GRADIENT OVERLAY */}
        <div className="absolute inset-0 bg-gradient-to-t from-zinc-950/80 via-transparent to-transparent pointer-events-none" />

        {/* HOVER PLAY BUTTON */}
        <div className="absolute inset-0 bg-black/30 opacity-0 group-hover/card:opacity-100 transition-opacity duration-200 flex items-center justify-center pointer-events-none">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-amber-500 text-black shadow-lg transition-transform duration-200 group-hover/card:scale-110">
            <Play size={18} className="ml-0.5 fill-black text-black" />
          </span>
        </div>

        {/* CLEAN RATING BADGE */}
        {media.rating && (
          <div className="absolute top-2 right-2 rounded-md bg-zinc-950/80 px-2 py-0.5 text-[10px] font-semibold text-amber-300 border border-zinc-800 backdrop-blur-md flex items-center gap-1">
            <Star size={10} className="fill-amber-400 text-amber-400" />
            <span>{typeof media.rating === 'number' ? media.rating.toFixed(1) : media.rating}</span>
          </div>
        )}
      </div>

      {/* TYPOGRAPHY & CLEAN METADATA */}
      <div className="mt-2 px-0.5 space-y-0.5">
        <h4 className="font-display text-sm font-semibold text-zinc-100 group-hover/card:text-amber-400 truncate transition-colors duration-150">
          {media.title}
        </h4>
        <div className="flex items-center gap-1.5 text-xs text-zinc-400">
          <span className="text-zinc-400">{getPrimaryGenre()}</span>
          {media.year && (
            <>
              <span className="text-zinc-600">•</span>
              <span className="text-zinc-500 text-[11px] font-mono">{media.year}</span>
            </>
          )}
        </div>
      </div>
    </article>
  );
});

export const MediaCardSkeleton: React.FC = () => {
  return (
    <div className="flex flex-col space-y-2 animate-pulse select-none w-full">
      <div className="aspect-[2/3] w-full rounded-xl bg-zinc-900 border border-zinc-800" />
      <div className="h-3.5 w-3/4 rounded bg-zinc-800" />
      <div className="h-2.5 w-1/2 rounded bg-zinc-850" />
    </div>
  );
};
