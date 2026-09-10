import React, { useEffect, useState } from 'react';
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
  const [hydratedVisuals, setHydratedVisuals] = useState<Partial<Show> | null>(null);

  useEffect(() => {
    setHydratedVisuals(null);

    const tmdbId = Number(media?.tmdb_id);
    if (media?.logo_url || !Number.isInteger(tmdbId) || tmdbId <= 0) return;

    const rawKind = `${media.kind || ''} ${media.category || ''}`.toLowerCase();
    const kind = rawKind.includes('movie') || rawKind.includes('pel') || rawKind.includes('cine')
      ? 'movie'
      : rawKind.includes('anime')
        ? 'anime'
        : 'series';

    let cancelled = false;
    fetch(`/api/v1/catalog/public/${kind}/${tmdbId}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((detail: Partial<Show> | null) => {
        if (cancelled || !detail) return;
        setHydratedVisuals({
          logo_url: detail.logo_url || null,
          poster_path: detail.poster_path || media.poster_path,
          backdrop_path: detail.backdrop_path || media.backdrop_path,
          banner_url: detail.banner_url || media.banner_url,
          backdrop_url: detail.backdrop_url || media.backdrop_url,
        });
      })
      .catch(() => {
        // La portada sigue siendo válida aunque la ficha visual no responda.
      });

    return () => {
      cancelled = true;
    };
  }, [media?.id, media?.tmdb_id, media?.logo_url]);

  if (!media) return null;

  const visualMedia = hydratedVisuals ? { ...media, ...hydratedVisuals } : media;

  const genres = (Array.isArray(visualMedia.genres) ? visualMedia.genres : String(visualMedia.genres || '').split(','))
    .map(g => g.trim())
    .filter(g => g && !isGenreHidden(g));
  const synopsis = visualMedia.description || visualMedia.synopsis || visualMedia.overview || 'Sin sinopsis disponible para este título.';
  const title = cleanDisplayTitle(visualMedia.title);

  return (
    <section className="feature" aria-label="Título destacado">
      <div className="feature-art">
        <SmartImage
          src={heroBackdropUrl(visualMedia)}
          srcSet={heroBackdropSrcSet(visualMedia)}
          sizes="100vw"
          alt=""
          className="feature-image"
          // El hero es un fondo panorámico; estas dimensiones reservan su
          // proporción antes de que llegue la respuesta del CDN y evitan CLS.
          width={1920}
          height={1080}
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
          <span>{contentLabel(visualMedia.category)}</span>
          {visualMedia.year && <span>{visualMedia.year}</span>}
          {!!visualMedia.rating && <span className="rating"><Star size={13} fill="currentColor" />{typeof visualMedia.rating === 'number' ? visualMedia.rating.toFixed(1) : visualMedia.rating}</span>}
        </div>
        <h1 className={visualMedia.logo_url ? 'feature-title feature-title--logo' : 'feature-title'}>
          {visualMedia.logo_url ? (
            <SmartImage
              src={visualMedia.logo_url}
              alt={title}
              className="feature-logo"
              loading="eager"
              decoding="async"
              fallback={<span>{title}</span>}
            />
          ) : title}
        </h1>
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
