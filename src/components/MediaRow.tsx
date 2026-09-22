import React, { useEffect, useRef, useState } from 'react';
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
  /** Carga la siguiente página de TMDB para este riel/categoría. */
  onLoadMore?: () => void;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  loadMoreLabel?: string;
  [key: string]: any;
}

export const MediaRow: React.FC<MediaRowProps> = ({ title, subtitle, items = [], onSelectMedia, onHoverMedia, isLoading = false, onLoadMore, hasMore = false, isLoadingMore = false, loadMoreLabel = 'Cargar más' }) => {
  const rowRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const [isNearViewport, setIsNearViewport] = useState(false);

  // Mount the cards only when the rail approaches the viewport. Keeping the
  // metadata in memory is cheap; keeping hundreds of image elements decoded
  // at startup is not. The generous margin keeps scrolling seamless.
  useEffect(() => {
    const section = sectionRef.current;
    if (!section || typeof IntersectionObserver === 'undefined') {
      setIsNearViewport(true);
      return;
    }

    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      setIsNearViewport(true);
      observer.disconnect();
    }, { rootMargin: '900px 0px' });

    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  const handleScroll = (direction: number) => {
    const row = rowRef.current;
    if (row) row.scrollBy({ left: direction * row.clientWidth * 0.75, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
  const id = `row-${title.toLowerCase().replace(/\s+/g, '-')}`;
  return (
    <section ref={sectionRef} className="media-row" id={id} style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 370px' }}>
      <div className="section-heading">
        <div><h3>{title}</h3>{subtitle && <p>{subtitle}</p>}</div>
        <div className="row-navigation">
          <span className="row-count">{items.length} títulos</span>
          {onLoadMore && hasMore && (
            <button
              type="button"
              className="row-loadmore"
              onClick={onLoadMore}
              disabled={isLoadingMore}
              aria-label={`${loadMoreLabel} de ${title}`}
            >
              {isLoadingMore ? 'Cargando…' : loadMoreLabel}
            </button>
          )}
          <button type="button" className="icon-button" onClick={() => handleScroll(-1)} aria-label={`Desplazar ${title} a la izquierda`} aria-controls={`${id}-items`}><ChevronLeft size={18} /></button>
          <button type="button" className="icon-button" onClick={() => handleScroll(1)} aria-label={`Desplazar ${title} a la derecha`} aria-controls={`${id}-items`}><ChevronRight size={18} /></button>
        </div>
      </div>
      <div ref={rowRef} id={`${id}-items`} className="poster-rail">
        {!isNearViewport && !isLoading ? <span className="media-row-deferred" aria-hidden="true" />
          : (isLoading && items.length === 0) ? Array.from({ length: 6 }, (_, i) => <div key={i} className="poster-slot"><MediaCardSkeleton /></div>)
          : items.length ? items.map(item => <div className="poster-slot" key={item.id}><MediaCard media={item} onSelectMedia={onSelectMedia} onHover={onHoverMedia} /></div>)
          : <p className="rail-empty"><Film size={20} />Sin títulos en esta sección</p>}
      </div>
    </section>
  );
};
