import React, { useEffect, useState } from 'react';
import { ArrowUpRight, Star, Film, Heart } from 'lucide-react';
import { SmartImage } from './SmartImage';
import { contentLabel } from '../utils/labels';
import { cardPosterCandidates, cardPosterSrcSet, cardPosterUrl } from '../utils/imageSizes';
import { cleanDisplayTitle, cleanDisplayGenres } from '../utils/textCleaner';
import { useHiddenGenres } from '../hooks/useHiddenGenres';
import type { Show } from '../types';
import { useAuth } from '../contexts/AuthContext';
import { APP_PREFERENCES_EVENT, getAppPreferences } from '../utils/appPreferences';
import { isNativeLowCostPresentation } from '../utils/runtime';
import { useUserLists } from '../hooks/useUserLists';

interface MediaCardProps {
  media: Show;
  onSelectMedia?: (media: Show) => void;
  onHover?: (media: Show) => void;
  isNew?: boolean;
  imageLoading?: 'lazy' | 'eager';
}

export const MediaCard: React.FC<MediaCardProps> = React.memo(({ media, onSelectMedia, onHover, imageLoading = 'lazy' }) => {
  const { user } = useAuth();
  const { isFavorite, toggleFavorite } = useUserLists();
  const isFav = isFavorite(media);
  const [showIdentityDetails, setShowIdentityDetails] = useState(false);
  const [showAdminEditButton, setShowAdminEditButton] = useState(false);
  useEffect(() => {
    const sync = () => {
      const prefs = getAppPreferences(user?.id);
      setShowIdentityDetails(Boolean(user?.is_admin && prefs.showIdentityDetails));
      setShowAdminEditButton(Boolean(user?.is_admin && prefs.showAdminEditButton !== false));
    };
    sync();
    window.addEventListener(APP_PREFERENCES_EVENT, sync);
    return () => window.removeEventListener(APP_PREFERENCES_EVENT, sync);
  }, [user?.id, user?.is_admin]);
  const title = cleanDisplayTitle(media.title);
  const lowCostPresentation = isNativeLowCostPresentation();
  const { isGenreHidden } = useHiddenGenres();
  const genre = cleanDisplayGenres(media.genres).find((item) => !isGenreHidden(item)) || contentLabel(media.category);
  const posterSources = cardPosterCandidates(media);
  return (
    <button
      type="button"
      className="media-card group relative"
      onClick={() => onSelectMedia?.(media)}
      onMouseEnter={() => onHover?.(media)}
      onFocus={() => onHover?.(media)}
      aria-label={`Ver detalles de ${title}`}
    >
      <span className="media-poster">
        <SmartImage
          src={cardPosterUrl(media)}
          sources={posterSources}
          srcSet={lowCostPresentation ? undefined : cardPosterSrcSet(media)}
          alt=""
          loading={imageLoading}
          sizes="(min-width: 1760px) 190px, (min-width: 1280px) 180px, (min-width: 768px) 22vw, 39vw"
          decoding="async"
          className="media-poster-image"
          fallback={<span className="poster-placeholder"><Film size={24} /><span>{title}</span><small>Portada no disponible</small></span>}
        />
        <span className="media-card-open" aria-hidden="true"><ArrowUpRight size={18} /></span>
        <span className="media-kind">{contentLabel(media.category)}</span>
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleFavorite(media);
          }}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              toggleFavorite(media);
            }
          }}
          data-card-favorite
          className={`absolute top-2 left-2 z-20 p-2 rounded-full transition-all duration-200 backdrop-blur-md shadow-lg cursor-pointer ${
            isFav
              ? 'opacity-100 bg-rose-600 text-white scale-105 shadow-rose-600/30 ring-2 ring-rose-400/50'
              : 'opacity-90 sm:opacity-0 sm:group-hover:opacity-100 hover:!opacity-100 bg-black/70 hover:bg-rose-600/90 text-zinc-300 hover:text-white hover:scale-110'
          }`}
          title={isFav ? 'Quitar de Favoritos' : 'Añadir a Favoritos'}
          aria-label={isFav ? 'Quitar de Favoritos' : 'Añadir a Favoritos'}
        >
          <Heart size={13} className={isFav ? 'fill-current text-white' : ''} />
        </span>
        {(showIdentityDetails || showAdminEditButton) && (
          <span className="absolute inset-x-1 bottom-1 flex flex-wrap gap-1 rounded-md bg-black/75 p-1 text-[8px] leading-none text-sky-100" onClick={(event) => event.stopPropagation()}>
            {showIdentityDetails && [
              ['TMDB', media.tmdb_id], ['IMDb', media.imdb_id], ['TVDB', media.tvdb_id],
              ['MAL', media.mal_id], ['AniList', media.anilist_id], ['Kitsu', media.kitsu_id], ['AniDB', media.anidb_id],
            ].filter(([, value]) => value !== null && value !== undefined && String(value).trim()).map(([label, value]) => <span key={label} className="rounded bg-sky-400/15 px-1 py-0.5">{label}: {String(value)}</span>)}
            {showAdminEditButton && <span
              role="link"
              tabIndex={0}
              className="ml-auto cursor-pointer rounded bg-amber-400/20 px-1 py-0.5 text-amber-200 hover:bg-amber-400/35"
              onClick={(event) => { event.stopPropagation(); window.location.assign(`/admin?show_id=${encodeURIComponent(String(media.id))}&tmdb_id=${encodeURIComponent(String(media.tmdb_id || ''))}&kind=${encodeURIComponent(String(media.category || ''))}`); }}
              onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); window.location.assign(`/admin?show_id=${encodeURIComponent(String(media.id))}&tmdb_id=${encodeURIComponent(String(media.tmdb_id || ''))}&kind=${encodeURIComponent(String(media.category || ''))}`); } }}
            >Editar</span>}
          </span>
        )}
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
