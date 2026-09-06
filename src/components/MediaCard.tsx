import React from 'react';
import { ArrowUpRight, Star, Film } from 'lucide-react';
import { SmartImage } from './SmartImage';
import { contentLabel } from '../utils/labels';
import { cardPosterUrl } from '../utils/imageSizes';
import { cleanDisplayTitle, cleanDisplayGenres } from '../utils/textCleaner';
import type { Show } from '../types';

interface MediaCardProps {
  media: Show;
  onSelectMedia?: (media: Show) => void;
  onHover?: (media: Show) => void;
  isNew?: boolean;
}

export const MediaCard: React.FC<MediaCardProps> = React.memo(({ media, onSelectMedia, onHover }) => {
  const title = cleanDisplayTitle(media.title);
  const genre = cleanDisplayGenres(media.genres)[0] || contentLabel(media.category);
  return (
    <button type="button" className="media-card" onClick={() => onSelectMedia?.(media)}
      onMouseEnter={() => onHover?.(media)} aria-label={`Ver detalles de ${title}`}>
      <span className="media-poster">
        <SmartImage src={cardPosterUrl(media)} alt="" sizes="(min-width: 1280px) 200px, (min-width: 640px) 180px, 44vw"
          className="media-poster-image" fallback={<span className="poster-placeholder"><Film size={24} /><span>{title}</span><small>Portada no disponible</small></span>} />
        <span className="media-card-open" aria-hidden="true"><ArrowUpRight size={19} /></span>
        <span className="media-kind">{contentLabel(media.category)}</span>
      </span>
      <span className="media-card-title" title={title}>{title}</span>
      <span className="media-card-meta"><span>{genre}{media.year ? ` · ${media.year}` : ''}</span>
        {!!media.rating && <span className="rating"><Star size={11} />{typeof media.rating === 'number' ? media.rating.toFixed(1) : media.rating}</span>}
      </span>
    </button>
  );
});

export const MediaCardSkeleton: React.FC = () => (
  <div className="media-skeleton" aria-hidden="true"><div /><span /><span /></div>
);
