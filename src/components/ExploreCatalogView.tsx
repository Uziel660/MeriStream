import React, { useEffect, useMemo, useRef } from 'react';
import { Film, ListFilter } from 'lucide-react';
import type { Show } from '../types';
import { MediaCard } from './MediaCard';
import { CatalogFilters, type SortMode } from './CatalogFilters';
import { FilterMenu } from './FilterMenu';
import { useHiddenGenres } from '../hooks/useHiddenGenres';

interface ExploreCatalogViewProps {
  shows: Show[];
  allGenresList: string[];
  showsCountByGenre: Record<string, number>;
  genreFilter: string | null;
  onGenreFilter: (g: string | null) => void;
  yearFilter: number | null;
  onYearFilter: (y: number | null) => void;
  sortBy: SortMode;
  onSortBy: (s: SortMode) => void;
  catalogPageSize: number;
  onLoadMore: (hasHiddenItems?: boolean) => void | Promise<void>;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  availableYears: number[];
  onSelectMedia: (m: Show) => void;
  onHoverMedia?: (m: Show | null) => void;
}

export const ExploreCatalogView: React.FC<ExploreCatalogViewProps> = ({
  shows, allGenresList, showsCountByGenre, genreFilter, onGenreFilter, yearFilter, onYearFilter,
  sortBy, onSortBy, catalogPageSize, onLoadMore, hasMore = false, isLoadingMore = false,
  availableYears, onSelectMedia, onHoverMedia,
}) => {
  const { isGenreHidden, isShowHidden } = useHiddenGenres();
  const autoLoadSentinelRef = useRef<HTMLDivElement | null>(null);

  const validGenres = useMemo(() => allGenresList
    .filter((genre) => {
      const clean = genre.trim();
      if (!clean) return false;
      const low = clean.toLowerCase();
      if (['multimedia', 'anime', 'película', 'serie'].includes(low)) return false;
      return !isGenreHidden(clean);
    })
    .sort((a, b) => (showsCountByGenre[b.toLowerCase()] || 0) - (showsCountByGenre[a.toLowerCase()] || 0)),
  [allGenresList, showsCountByGenre, isGenreHidden]);

  // Shows filtrados por género y año
  const filteredShows = useMemo(() => {
    let result = shows.filter((show) => !isShowHidden(show));

    if (genreFilter) {
      const gf = genreFilter.toLowerCase();
      result = result.filter((show) => {
        const genres = Array.isArray(show.genres) ? show.genres : String(show.genres || '').split(',');
        return genres.some((genre) => genre.trim().toLowerCase() === gf);
      });
    }
    if (yearFilter !== null) result = result.filter((show) => Number(show.year) === yearFilter);
    if (sortBy === 'rating') result = [...result].sort((a, b) => (b.rating || 0) - (a.rating || 0));
    else if (sortBy === 'anio') result = [...result].sort((a, b) => (Number(b.year) || 0) - (Number(a.year) || 0));
    else if (sortBy === 'az') result = [...result].sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'es'));

    return result;
  }, [isShowHidden, shows, genreFilter, yearFilter, sortBy]);

  const resetFilters = () => { onGenreFilter(null); onYearFilter(null); onSortBy('recientes'); };

  // Explorar no necesita botones de paginación: primero revela el buffer ya
  // disponible y, cuando se agota, pide otra página al catálogo remoto.
  useEffect(() => {
    const sentinel = autoLoadSentinelRef.current;
    if (!sentinel || typeof IntersectionObserver === 'undefined') return;
    const hasHiddenItems = filteredShows.length > catalogPageSize;
    if (!hasHiddenItems && !hasMore) return;
    if (isLoadingMore) return;

    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting || isLoadingMore) return;
      void Promise.resolve(onLoadMore(filteredShows.length > catalogPageSize));
    }, { rootMargin: '0px 0px 500px 0px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [catalogPageSize, filteredShows.length, hasMore, isLoadingMore, onLoadMore]);

  return (
    <section className="catalog-shell" aria-labelledby="catalog-title">
      <div className="catalog-titlebar">
        <div>
          <h2 id="catalog-title">Explorar catálogo</h2>
          <p>Películas, series y anime en una biblioteca unificada.</p>
        </div>
        <span className="catalog-count" aria-live="polite">{filteredShows.length} {filteredShows.length === 1 ? 'título' : 'títulos'}</span>
      </div>

      <div className="catalog-toolbar catalog-toolbar--explore" aria-label="Filtros del catálogo">
        <FilterMenu
          ariaLabel="Filtrar por género"
          icon={<ListFilter size={14} />}
          value={genreFilter || ''}
          placeholder="Todos los géneros"
          options={[{ value: '', label: 'Todos los géneros' }, ...validGenres.map((genre) => {
            const count = showsCountByGenre[genre.toLowerCase()] || 0;
            return { value: genre, label: `${genre}${count ? ` · ${count}` : ''}` };
          })]}
          onChange={(value) => onGenreFilter(value || null)}
        />
        <CatalogFilters years={availableYears} year={yearFilter} onYear={onYearFilter} sort={sortBy} onSort={onSortBy} />
        {genreFilter && <button type="button" className="filter-clear" onClick={() => onGenreFilter(null)}>Quitar género</button>}
      </div>

      {filteredShows.length === 0 ? (
        <div className="catalog-empty" role="status">
          <Film size={38} aria-hidden="true" />
          <div><strong>No encontramos títulos con esos filtros.</strong><p className="mt-1 text-xs text-zinc-500">Prueba otra combinación o vuelve al catálogo completo.</p></div>
          <button type="button" onClick={resetFilters}>Restablecer filtros</button>
        </div>
      ) : (
        <>
          <div className="catalog-grid" style={{ contentVisibility: 'auto', containIntrinsicSize: '1200px' }}>
            {filteredShows.slice(0, catalogPageSize).map((item) => (
              <MediaCard key={item.id} media={item} onSelectMedia={onSelectMedia} onHover={onHoverMedia} />
            ))}
          </div>
          <div ref={autoLoadSentinelRef} className="catalog-autoload-sentinel" aria-hidden="true" />
          {isLoadingMore && <p className="catalog-autoload-status" role="status" aria-live="polite">Cargando más títulos…</p>}
        </>
      )}
    </section>
  );
};
