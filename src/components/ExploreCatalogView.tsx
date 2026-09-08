import React, { useMemo } from 'react';
import { Grid3X3, Film, ListFilter } from 'lucide-react';
import type { Show } from '../types';
import { MediaCard } from './MediaCard';
import { CatalogFilters, type SortMode } from './CatalogFilters';
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
  onLoadMore: () => void;
  availableYears: number[];
  onSelectMedia: (m: Show) => void;
  onHoverMedia?: (m: Show | null) => void;
}

export const ExploreCatalogView: React.FC<ExploreCatalogViewProps> = ({
  shows, allGenresList, showsCountByGenre, genreFilter, onGenreFilter, yearFilter, onYearFilter,
  sortBy, onSortBy, catalogPageSize, onLoadMore, availableYears, onSelectMedia, onHoverMedia,
}) => {
  const { isGenreHidden } = useHiddenGenres();

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

  const filteredShows = useMemo(() => {
    let result = shows;
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
  }, [shows, genreFilter, yearFilter, sortBy]);

  const resetFilters = () => { onGenreFilter(null); onYearFilter(null); onSortBy('recientes'); };

  return (
    <section className="catalog-shell" aria-labelledby="catalog-title">
      <div className="catalog-titlebar">
        <div className="catalog-kicker">
          <span className="catalog-kicker-icon" aria-hidden="true"><Grid3X3 size={17} /></span>
          <div>
            <h2 id="catalog-title">Explorar catálogo</h2>
            <p>Películas, series y anime en una biblioteca unificada.</p>
          </div>
        </div>
        <span className="catalog-count" aria-live="polite">{filteredShows.length} {filteredShows.length === 1 ? 'título' : 'títulos'}</span>
      </div>

      <div className="catalog-toolbar" aria-label="Filtros del catálogo">
        <label className="filter-control">
          <ListFilter size={14} aria-hidden="true" />
          <span className="sr-only">Filtrar por género</span>
          <select value={genreFilter ?? ''} onChange={(event) => onGenreFilter(event.target.value || null)} className="filter-select" aria-label="Filtrar por género">
            <option value="">Todos los géneros</option>
            {validGenres.map((genre) => {
              const count = showsCountByGenre[genre.toLowerCase()] || 0;
              return <option key={genre} value={genre}>{genre}{count ? ` (${count})` : ''}</option>;
            })}
          </select>
        </label>
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
          {filteredShows.length > catalogPageSize && (
            <div className="catalog-loadmore">
              <button type="button" onClick={onLoadMore}>Mostrar más · {filteredShows.length - catalogPageSize} restantes</button>
            </div>
          )}
        </>
      )}
    </section>
  );
};
