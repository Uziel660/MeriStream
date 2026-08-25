// src/components/HeroBanner.tsx
import React, { useEffect, useState } from 'react';
import { Play, Info, Star } from 'lucide-react';
import { contentLabel } from '../utils/labels';
import { extractDominantColor, rgbToRgbaString } from '../utils/colorExtractor';
import { heroBackdropUrl } from '../utils/imageSizes';
import { SmartImage } from './SmartImage';
import type { Show } from '../types';

interface HeroBannerProps {
  media: Show;
  onPlay?: () => void;
  onMoreInfo?: () => void;
}

export const HeroBanner: React.FC<HeroBannerProps> = ({ media, onPlay, onMoreInfo }) => {
  const [accentRgb, setAccentRgb] = useState<[number, number, number]>([245, 158, 11]);

  const image = heroBackdropUrl(media ?? {});
  const synopsis = media?.description || media?.synopsis || 'Sin sinopsis disponible para este título.';

  useEffect(() => {
    if (image) {
      extractDominantColor(image, media.title).then(setAccentRgb);
    }
  }, [image, media?.title]);

  if (!media) return null;

  // Safe genres list
  const getGenresList = (): string[] => {
    if (!media.genres) return [contentLabel(media.category)];
    if (Array.isArray(media.genres)) return media.genres;
    if (typeof media.genres === 'string') {
      return media.genres.split(',').map((g: string) => g.trim()).filter(Boolean);
    }
    return [contentLabel(media.category)];
  };

  const genres = getGenresList();
  const glowStyle = rgbToRgbaString(accentRgb, 0.25);

  return (
    <section className="relative h-[70vh] min-h-[500px] max-h-[720px] w-full overflow-hidden bg-zinc-950 select-none">
      {/* STATIC HIGH QUALITY BACKDROP WITH KEN BURNS SLOW ZOOM EFFECT */}
      {image && (
        <div className="absolute inset-0 overflow-hidden">
          <SmartImage
            src={image}
            alt={media.title}
            className="h-full w-full object-cover object-center opacity-50 animate-ken-burns"
          />
          {/* MULTI-LAYER CINEMATIC VIGNETTE & GRADIENTS */}
          <div className="absolute inset-0 bg-gradient-to-r from-zinc-950 via-zinc-950/75 to-transparent w-full md:w-4/5" />
          <div className="absolute inset-0 bg-gradient-to-t from-zinc-950 via-zinc-950/40 to-transparent" />
          <div
            className="absolute inset-0 pointer-events-none opacity-40 transition-opacity duration-1000"
            style={{
              background: `radial-gradient(circle at 75% 25%, ${glowStyle} 0%, transparent 65%)`,
            }}
          />
        </div>
      )}

      {/* HERO MAIN CONTENT */}
      <div className="relative z-10 max-w-7xl mx-auto h-full flex flex-col justify-end px-4 sm:px-8 pb-16 sm:pb-24">
        <div className="max-w-2xl space-y-4">

          {/* METADATA CHIPS */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="inline-flex items-center rounded-md bg-zinc-900/90 border border-zinc-800 px-2.5 py-1 text-zinc-300 text-xs font-medium backdrop-blur-md uppercase tracking-wider text-[11px]">
              {media.category === 'movie' ? 'Película' : (media.category === 'series' ? 'Serie' : 'Anime')}
            </span>

            {media.rating && (
              <span className="inline-flex items-center gap-1 rounded-md bg-black/70 border border-amber-500/20 px-2.5 py-1 text-amber-300 text-xs font-semibold backdrop-blur-md">
                <Star size={11} className="fill-amber-400 text-amber-400" />
                {typeof media.rating === 'number' ? media.rating.toFixed(1) : media.rating}
              </span>
            )}

            {media.year && (
              <span className="inline-flex items-center rounded-md bg-zinc-900/60 border border-zinc-800/80 px-2.5 py-1 text-zinc-400 text-xs font-mono">
                {media.year}
              </span>
            )}
          </div>

          {/* TITULO CON CONTRASTE Y TIPOGRAFÍA OUTFIT */}
          <h1 className="font-display text-3xl sm:text-5xl md:text-6xl font-extrabold text-white leading-[1.08] text-balance text-title-shadow">
            {media.title}
          </h1>

          {/* GÉNEROS CON CHIPS SEMI-TRANSPARENTES */}
          {genres.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-0.5">
              {genres.slice(0, 4).map((g, i) => (
                <span
                  key={i}
                  className="rounded-full bg-white/5 border border-white/10 px-3 py-0.5 text-xs text-zinc-300 font-medium backdrop-blur-sm"
                >
                  {g}
                </span>
              ))}
            </div>
          )}

          {/* SINOPSIS CON INTER */}
          <p className="text-xs sm:text-sm text-zinc-300/90 line-clamp-3 leading-relaxed text-contrast-shadow max-w-xl font-normal">
            {synopsis}
          </p>

          {/* BOTONES PRINCIPALES REDONDEADOS TIPO PÍLDORA (PILL-SHAPED) */}
          <div className="flex items-center gap-3 pt-3">
            <button
              type="button"
              onClick={onPlay}
              className="flex items-center gap-2 rounded-full bg-white hover:bg-zinc-200 text-zinc-950 px-7 py-3 text-xs sm:text-sm font-bold shadow-xl transition-all duration-200 hover:scale-105 active:scale-95 cursor-pointer"
            >
              <Play size={17} className="fill-zinc-950 text-zinc-950 ml-0.5" />
              Reproducir
            </button>

            <button
              type="button"
              onClick={onMoreInfo}
              className="flex items-center gap-2 rounded-full bg-zinc-900/90 hover:bg-zinc-800 border border-zinc-700/80 px-6 py-3 text-xs sm:text-sm font-semibold text-zinc-100 backdrop-blur-md transition-all duration-200 hover:scale-105 active:scale-95 cursor-pointer"
            >
              <Info size={17} className="text-zinc-400" />
              Detalles
            </button>
          </div>
        </div>
      </div>
    </section>
  );
};
