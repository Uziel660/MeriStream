// src/components/BentoCollection.tsx
import React, { useState, useEffect } from 'react';
import { Play, Star } from 'lucide-react';
import { extractDominantColor, rgbToRgbaString } from '../utils/colorExtractor';
import type { Show } from '../types';

interface BentoCollectionProps {
  title: string;
  badge?: string;
  items: Show[];
  onSelectMedia: (media: Show) => void;
  onHover?: (media: Show) => void;
}

export const BentoCollection: React.FC<BentoCollectionProps> = ({
  title,
  items,
  onSelectMedia,
  onHover,
}) => {
  if (!items || items.length === 0) return null;

  const mainItem = items[0];
  const sideItems = items.slice(1, 5);

  return (
    <section className="space-y-4">
      {/* SECTION HEADER */}
      <div className="flex items-center justify-between">
        <h3 className="font-display text-xl sm:text-2xl font-bold text-white tracking-tight">
          {title}
        </h3>
      </div>

      {/* ASYMMETRIC BENTO GRID: 1 LARGE ON THE LEFT, 4 SMALL ON THE RIGHT */}
      <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-4 sm:gap-5">

        {/* LARGE FEATURED POSTER (Spans 2 columns on desktop) */}
        {mainItem && (
          <div className="md:col-span-2 lg:col-span-2">
            <BentoMainCard
              media={mainItem}
              onSelect={() => onSelectMedia(mainItem)}
              onHover={() => onHover && onHover(mainItem)}
            />
          </div>
        )}

        {/* 4 SMALLER POSTERS ON THE RIGHT (2x2 grid) */}
        <div className="md:col-span-1 lg:col-span-2 grid grid-cols-2 gap-3 sm:gap-4">
          {sideItems.map((item) => (
            <BentoMiniCard
              key={item.id}
              media={item}
              onSelect={() => onSelectMedia(item)}
              onHover={() => onHover && onHover(item)}
            />
          ))}
        </div>
      </div>
    </section>
  );
};

interface BentoCardProps {
  media: Show;
  onSelect: () => void;
  onHover: () => void;
}

const BentoMainCard: React.FC<BentoCardProps> = ({ media, onSelect, onHover }) => {
  const [accentRgb, setAccentRgb] = useState<[number, number, number]>([245, 158, 11]);
  const image = media.backdrop_url || media.banner_url || media.poster_url;

  useEffect(() => {
    if (image) {
      extractDominantColor(image, media.title).then(setAccentRgb);
    }
  }, [image, media.title]);

  const glowRgba = rgbToRgbaString(accentRgb, 0.2);

  return (
    <div
      onClick={onSelect}
      onMouseEnter={onHover}
      className="group/bento relative h-full min-h-[360px] sm:min-h-[420px] rounded-2xl overflow-hidden bg-zinc-900 border border-zinc-800 hover:border-zinc-700 shadow-xl transition-all duration-300 cursor-pointer select-none flex flex-col justify-end p-6 sm:p-8"
    >
      {/* BACKGROUND ART WITH INNER ZOOM */}
      {image && (
        <img
          src={image}
          alt={media.title}
          className="absolute inset-0 h-full w-full object-cover object-center filter brightness-90 transition-transform duration-700 ease-out group-hover/bento:scale-105"
        />
      )}

      {/* GRADIENTS */}
      <div className="absolute inset-0 bg-gradient-to-t from-zinc-950 via-zinc-950/70 to-transparent" />
      <div
        className="absolute inset-0 pointer-events-none opacity-40 transition-opacity group-hover/bento:opacity-60"
        style={{
          background: `radial-gradient(circle at 80% 20%, ${glowRgba} 0%, transparent 60%)`,
        }}
      />

      {/* CENTER PLAY OVERLAY */}
      <div className="absolute inset-0 bg-black/20 opacity-0 group-hover/bento:opacity-100 transition-opacity duration-300 flex items-center justify-center pointer-events-none">
        <span className="flex h-13 w-13 items-center justify-center rounded-full bg-amber-500 text-black shadow-2xl transition-transform duration-300 group-hover/bento:scale-110">
          <Play size={22} className="ml-0.5 fill-black text-black" />
        </span>
      </div>

      {/* CONTENT */}
      <div className="relative z-10 space-y-2 max-w-lg">
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <span className="rounded-md bg-zinc-950/80 border border-zinc-800 px-2.5 py-0.5 text-zinc-300 text-[11px] font-medium uppercase tracking-wider">
            {media.category === 'movie' ? 'Película' : 'Serie'}
          </span>
          {media.rating && (
            <span className="rounded-md bg-zinc-950/80 border border-zinc-800 px-2 py-0.5 text-amber-300 font-semibold flex items-center gap-1 text-[11px]">
              <Star size={11} className="fill-amber-400 text-amber-400" />
              {typeof media.rating === 'number' ? media.rating.toFixed(1) : media.rating}
            </span>
          )}
          {media.year && (
            <span className="text-zinc-400 font-mono text-[11px]">{media.year}</span>
          )}
        </div>

        <h4 className="font-display text-2xl sm:text-3xl font-extrabold text-white leading-tight group-hover/bento:text-amber-400 transition-colors text-title-shadow">
          {media.title}
        </h4>

        {media.description && (
          <p className="text-xs sm:text-sm text-zinc-300/90 line-clamp-2 leading-relaxed text-contrast-shadow">
            {media.description}
          </p>
        )}
      </div>
    </div>
  );
};

const BentoMiniCard: React.FC<BentoCardProps> = ({ media, onSelect, onHover }) => {
  const image = media.poster_url || media.banner_url;

  return (
    <div
      onClick={onSelect}
      onMouseEnter={onHover}
      className="group/mini relative aspect-[4/5] rounded-xl overflow-hidden bg-zinc-900 border border-zinc-800 hover:border-zinc-700 transition-all duration-300 cursor-pointer select-none flex flex-col justify-end p-3"
    >
      {image && (
        <img
          src={image}
          alt={media.title}
          className="absolute inset-0 h-full w-full object-cover object-center filter brightness-90 transition-transform duration-500 ease-out group-hover/mini:scale-105"
        />
      )}

      <div className="absolute inset-0 bg-gradient-to-t from-zinc-950 via-zinc-950/60 to-transparent" />

      {/* PLAY BUTTON ON HOVER */}
      <div className="absolute inset-0 bg-black/25 opacity-0 group-hover/mini:opacity-100 transition-opacity duration-300 flex items-center justify-center pointer-events-none">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-amber-500 text-black shadow-lg">
          <Play size={15} className="ml-0.5 fill-black text-black" />
        </span>
      </div>

      <div className="relative z-10 space-y-1">
        <div className="flex items-center justify-between text-[10px] text-zinc-400 font-mono">
          <span className="capitalize">{media.category || 'Anime'}</span>
          {media.rating && (
            <span className="text-amber-300 font-semibold flex items-center gap-0.5">
              <Star size={9} className="fill-amber-400 text-amber-400" />
              {typeof media.rating === 'number' ? media.rating.toFixed(1) : media.rating}
            </span>
          )}
        </div>
        <h5 className="font-display text-xs font-semibold text-white group-hover/mini:text-amber-400 truncate transition-colors">
          {media.title}
        </h5>
      </div>
    </div>
  );
};
