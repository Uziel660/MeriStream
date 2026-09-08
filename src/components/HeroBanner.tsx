import React from 'react';
import { Play, Info, Star } from 'lucide-react';
import { contentLabel } from '../utils/labels';
import { heroBackdropSrcSet, heroBackdropUrl } from '../utils/imageSizes';
import { cleanDisplayTitle } from '../utils/textCleaner';
import { SmartImage } from './SmartImage';
import { useHiddenGenres } from '../hooks/useHiddenGenres';
import type { Show } from '../types';

interface HeroBannerProps {
  media: Show;
  onPlay?: () => void;
  onMoreInfo?: () => void;
}

export const HeroBanner: React.FC<HeroBannerProps> = ({ media, onPlay, onMoreInfo }) => {
  const { isGenreHidden } = useHiddenGenres();
  if (!media) return null;

  const genres = (Array.isArray(media.genres) ? media.genres : String(media.genres || '').split(','))
    .map(g => g.trim())
    .filter(g => g && !isGenreHidden(g));
  const synopsis = media.description || media.synopsis || media.overview || 'Sin sinopsis disponible para este título.';

  return (
    <section className="feature" aria-label="Título destacado">
      <div className="feature-art">
        <SmartImage
          src={heroBackdropUrl(media)}
          srcSet={heroBackdropSrcSet(media)}
          sizes="100vw"
          alt=""
          className="feature-image"
          loading="eager"
          fetchPriority="high"
          decoding="async"
          fallback={<div className="feature-placeholder" aria-hidden="true"><span>M</span></div>}
        />
        <div className="feature-shade" aria-hidden="true" />
        <span className="feature-caption">MeriStream / destacado</span>
      </div>

      <div className="feature-content">
        <p className="eyebrow"><span className="feature-dash" />Selección para ti</p>
        <div className="feature-meta">
          <span>{contentLabel(media.category)}</span>
          {media.year && <span>{media.year}</span>}
          {!!media.rating && <span className="rating"><Star size={13} fill="currentColor" />{typeof media.rating === 'number' ? media.rating.toFixed(1) : media.rating}</span>}
        </div>
        <h1>{cleanDisplayTitle(media.title)}</h1>
        {genres.length > 0 && <p className="feature-genres">{genres.slice(0, 3).join(' · ')}</p>}
        <p className="feature-synopsis">{synopsis}</p>
        <div className="feature-actions">
          <button type="button" onClick={onPlay} className="button-primary"><Play size={18} fill="currentColor" />Reproducir</button>
          <button type="button" onClick={onMoreInfo} className="button-secondary"><Info size={18} />Más información</button>
        </div>
      </div>
    </section>
  );
};
