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

export const MediaRow: React.FC<MediaRowProps> = ({ title, subtitle, items = [], onSelectMedia, onHoverMedia, isLoading = false }) => {
  const rowRef = useRef<HTMLDivElement>(null);
  const handleScroll = (direction: number) => {
    const row = rowRef.current;
    if (row) row.scrollBy({ left: direction * row.clientWidth * 0.75, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
  const id = `row-${title.toLowerCase().replace(/\s+/g, '-')}`;
  return (
    <section className="media-row" id={id} style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 370px' }}>
      <div className="section-heading">
        <div><h3>{title}</h3>{subtitle && <p>{subtitle}</p>}</div>
        <div className="row-navigation">
          <span className="row-count">{items.length} títulos</span>
          <button type="button" className="icon-button" onClick={() => handleScroll(-1)} aria-label={`Desplazar ${title} a la izquierda`} aria-controls={`${id}-items`}><ChevronLeft size={18} /></button>
          <button type="button" className="icon-button" onClick={() => handleScroll(1)} aria-label={`Desplazar ${title} a la derecha`} aria-controls={`${id}-items`}><ChevronRight size={18} /></button>
        </div>
      </div>
      <div ref={rowRef} id={`${id}-items`} className="poster-rail">
        {isLoading ? Array.from({ length: 6 }, (_, i) => <div key={i} className="poster-slot"><MediaCardSkeleton /></div>)
          : items.length ? items.map(item => <div className="poster-slot" key={item.id}><MediaCard media={item} onSelectMedia={onSelectMedia} onHover={onHoverMedia} /></div>)
          : <p className="rail-empty"><Film size={20} />Sin títulos en esta sección</p>}
      </div>
    </section>
  );
};
