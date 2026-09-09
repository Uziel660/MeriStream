import React from 'react';
import { ArrowUpRight, Star, Film } from 'lucide-react';
import { SmartImage } from './SmartImage';
import { contentLabel } from '../utils/labels';
import { cardPosterCandidates, cardPosterSrcSet, cardPosterUrl } from '../utils/imageSizes';
import { cleanDisplayTitle, cleanDisplayGenres } from '../utils/textCleaner';
import { useHiddenGenres } from '../hooks/useHiddenGenres';
import type { Show } from '../types';

interface MediaCardProps {
  media: Show;
  onSelectMedia?: (media: Show) => void;
  onHover?: (media: Show) => void;
  isNew?: boolean;
  imageLoading?: 'lazy' | 'eager';
}

export const MediaCard: React.FC<MediaCardProps> = React.memo(({ media, onSelectMedia, onHover, imageLoading = 'lazy' }) => {
  const title = cleanDisplayTitle(media.title);
  const { isGenreHidden } = useHiddenGenres();
  const genre = cleanDisplayGenres(media.genres).find((item) => !isGenreHidden(item)) || contentLabel(media.category);
  const posterSources = cardPosterCandidates(media);
  return (
    <button
      type="button"
      className="media-card"
      onClick={() => onSelectMedia?.(media)}
      onMouseEnter={() => onHover?.(media)}
      onFocus={() => onHover?.(media)}
      aria-label={`Ver detalles de ${title}`}
    >
      <span className="media-poster">
        <SmartImage
          src={cardPosterUrl(media)}
          sources={posterSources}
          srcSet={cardPosterSrcSet(media)}
          alt=""
          loading={imageLoading}
          sizes="(min-width: 1760px) 190px, (min-width: 1280px) 180px, (min-width: 768px) 22vw, 39vw"
          decoding="async"
          className="media-poster-image"
          fallback={<span className="poster-placeholder"><Film size={24} /><span>{title}</span><small>Portada no disponible</small></span>}
        />
        <span className="media-card-open" aria-hidden="true"><ArrowUpRight size={18} /></span>
        <span className="media-kind">{contentLabel(media.category)}</span>
      </span>
      <span className="media-card-title" title={title}>{title}</span>
      <span className="media-card-meta">
        <span>{genre}{media.year ? ` · ${media.year}` : ''}</span>
        {!!media.rating && <span className="rating"><Star size={11} fill="currentColor" />{typeof media.rating === 'number' ? media.rating.toFixed(1) : media.rating}</span>}
      </span>
    </button>
  );
});

export const MediaCardSkeleton: React.FC = () => (
  <div className="media-skeleton" aria-hidden="true"><div className="ui-skeleton" /><span className="ui-skeleton" /><span className="ui-skeleton" /></div>
);
