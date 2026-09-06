// src/components/MediaRow.tsx
import React, { useRef } from 'react';
import { ChevronLeft, ChevronRight, Film } from 'lucide-react';
import { MediaCard, MediaCardSkeleton } from './MediaCard';
import type { Show } from '../types';

interface MediaRowProps {
  title: string;
  subtitle?: string;
  items: Show[];
  onSelectMedia?: (media: Show) => void;
  onHoverMedia?: (media: Show) => void;
  isLoading?: boolean;
  [key: string]: any;
}

export const MediaRow: React.FC<MediaRowProps> = ({
  title,
  subtitle,
  items = [],
  onSelectMedia,
  onHoverMedia,
  isLoading = false,
}) => {
  const rowRef = useRef<HTMLDivElement>(null);

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

  return (
    <section
      className="relative space-y-3 select-none"
      id={`row-${title.toLowerCase().replace(/\s+/g, '-')}`}
      style={{ contentVisibility: 'auto', containIntrinsicSize: '0 300px' }}
    >
      {/* HEADER DE FILA LIMPIO */}
      <div className="flex items-end justify-between px-1">
        <div>
          <h3 className="font-display text-lg sm:text-xl font-bold text-zinc-100 tracking-tight">
            {title}
          </h3>
          {subtitle && (
            <p className="text-xs text-zinc-400 font-normal mt-0.5">{subtitle}</p>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-zinc-400 font-medium">
          <span className="font-mono text-[11px] text-zinc-500">
            {items.length} {items.length === 1 ? 'título' : 'títulos'}
          </span>
        </div>
      </div>

      {/* CONTENEDOR DE FILA CON GRUPO AISLADO (group/row) */}
      <div className="group/row relative">
        {/* BOTÓN SCROLL IZQUIERDA */}
        <button
          type="button"
          onClick={() => handleScroll('left')}
          aria-label="Desplazar a la izquierda"
          className="absolute left-0 top-1/2 -translate-y-1/2 z-20 hidden group-hover/row:flex h-12 w-10 items-center justify-center rounded-r-xl bg-zinc-950/90 text-zinc-200 backdrop-blur-md border-r border-y border-zinc-800 transition-all hover:bg-amber-500 hover:text-black hover:w-11 shadow-2xl"
        >
          <ChevronLeft size={22} />
        </button>

        {/* CONTENEDOR CARRUSEL */}
        <div
          ref={rowRef}
          className="flex gap-4 overflow-x-auto pb-4 pt-1 px-1 scrollbar-none scroll-smooth items-stretch"
        >
          {isLoading ? (
            Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="w-36 sm:w-48 shrink-0">
                <MediaCardSkeleton />
              </div>
            ))
          ) : items.length > 0 ? (
            items.map((item) => (
              <div key={item.id} className="w-36 sm:w-48 shrink-0">
                <MediaCard
                  media={item}
                  onSelectMedia={onSelectMedia}
                  onHover={onHoverMedia}
                />
              </div>
            ))
          ) : (
            <div className="py-8 px-4 text-xs text-zinc-500 flex items-center gap-2">
              <Film size={16} /> Sin títulos en esta sección
            </div>
          )}
        </div>

        {/* BOTÓN SCROLL DERECHA */}
        <button
          type="button"
          onClick={() => handleScroll('right')}
          aria-label="Desplazar a la derecha"
          className="absolute right-0 top-1/2 -translate-y-1/2 z-20 hidden group-hover/row:flex h-12 w-10 items-center justify-center rounded-l-xl bg-zinc-950/90 text-zinc-200 backdrop-blur-md border-l border-y border-zinc-800 transition-all hover:bg-amber-500 hover:text-black hover:w-11 shadow-2xl"
        >
          <ChevronRight size={22} />
        </button>
      </div>
    </section>
  );
};
