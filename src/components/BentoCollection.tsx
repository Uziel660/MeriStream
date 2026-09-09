import React from 'react';
import { ArrowUpRight, Star } from 'lucide-react';
import { contentLabel } from '../utils/labels';
import { bentoBackdropSrcSet, bentoBackdropUrl, cardPosterCandidates, cardPosterSrcSet, cardPosterUrl } from '../utils/imageSizes';
import { SmartImage } from './SmartImage';
import type { Show } from '../types';

interface BentoCollectionProps {
  title: string;
  badge?: string;
  items: Show[];
  onSelectMedia: (media: Show) => void;
  onHover?: (media: Show) => void;
}

export const BentoCollection: React.FC<BentoCollectionProps> = ({ title, items, onSelectMedia, onHover }) => {
  if (!items?.length) return null;
  const main = items[0];
  return (
    <section className="spotlight-section" style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 460px' }}>
      <div className="section-heading"><div><p className="eyebrow">Vale la pena descubrir</p><h3>{title}</h3></div></div>
      <div className="spotlight-layout">
        <button type="button" className="spotlight-main" onClick={() => onSelectMedia(main)} onMouseEnter={() => onHover?.(main)}>
          <SmartImage
            src={bentoBackdropUrl(main)}
            srcSet={bentoBackdropSrcSet(main)}
            sizes="(max-width: 760px) 100vw, 66vw"
            alt=""
            className="spotlight-image"
          />
          <span className="spotlight-shade" />
          <span className="spotlight-copy"><span className="eyebrow">{contentLabel(main.category)} / {main.year}</span>
            <span className="spotlight-title">{main.title}</span>
            {main.description && <span className="spotlight-description">{main.description}</span>}
            <span className="spotlight-link">Ver detalles <ArrowUpRight size={18} /></span>
          </span>
        </button>
        <div className="spotlight-list">{items.slice(1, 5).map(item => (
          <button type="button" key={item.id} className="spotlight-item" onClick={() => onSelectMedia(item)} onMouseEnter={() => onHover?.(item)}>
            <span className="spotlight-thumb">
              <SmartImage
                src={cardPosterUrl(item)}
                sources={cardPosterCandidates(item)}
                srcSet={cardPosterSrcSet(item)}
                sizes="(max-width: 760px) 24vw, 112px"
                alt=""
              />
            </span>
            <span className="spotlight-item-copy"><span>{contentLabel(item.category)} · {item.year}</span><strong>{item.title}</strong>
              {!!item.rating && <span className="rating"><Star size={12} />{typeof item.rating === 'number' ? item.rating.toFixed(1) : item.rating}</span>}
            </span><ArrowUpRight size={18} className="spotlight-arrow" />
          </button>
        ))}</div>
      </div>
    </section>
  );
};
