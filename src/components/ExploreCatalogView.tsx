import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Film, ListFilter, SlidersHorizontal, X } from 'lucide-react';
import type { Show } from '../types';
import { MediaCard } from './MediaCard';
import { CatalogFilters, type SortMode } from './CatalogFilters';
import { FilterMenu } from './FilterMenu';
import { useHiddenGenres } from '../hooks/useHiddenGenres';
import { normalizeText } from '../utils/searchUtils';
import { isNativeShell, nativeHaptic } from '../utils/runtime';

const CANONICAL_FALLBACK_GENRES: string[] = [
  'Acción',
  'Acción y aventura',
  'Animación',
  'Aventura',
  'Bélica',
  'Bélica y política',
  'Ciencia ficción',
  'Ciencia ficción y fantasía',
  'Comedia',
  'Crimen',
  'Documental',
  'Drama',
  'Familia',
  'Fantasía',
  'Historia',
  'Infantil',
  'Isekai',
  'Mecha',
  'Misterio',
  'Música',
  'Noticias',
  'Película de TV',
  'Reality',
  'Romance',
  'Seinen',
  'Shounen',
  'Slice of Life',
  'Sobrenatural',
  'Suspenso',
  'Terror',
  'Western',
];

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
  shows, allGenresList, genreFilter, onGenreFilter, yearFilter, onYearFilter,
  sortBy, onSortBy, catalogPageSize, onLoadMore, hasMore = false, isLoadingMore = false,
  availableYears, onSelectMedia, onHoverMedia,
}) => {
  const { isGenreHidden, isShowHidden } = useHiddenGenres();
  const autoLoadSentinelRef = useRef<HTMLDivElement | null>(null);
  const nativeShell = isNativeShell();
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const activeFilterCount = Number(Boolean(genreFilter)) + Number(yearFilter !== null) + Number(sortBy !== 'recientes');

  const validGenres = useMemo(() => {
    const source = (allGenresList && allGenresList.length > 0) ? allGenresList : CANONICAL_FALLBACK_GENRES;
    return source
      .filter((genre) => {
        const clean = genre.trim();
        if (!clean) return false;
        const low = clean.toLowerCase();
        if (['multimedia', 'anime', 'película', 'serie'].includes(low)) return false;
        return !isGenreHidden(clean);
      })
      .sort((a, b) => a.localeCompare(b, 'es'));
  }, [allGenresList, isGenreHidden]);

  // Shows filtrados por género y año con compatibilidad flexible de nombres TMDB
  const filteredShows = useMemo(() => {
    let result = shows.filter((show) => !isShowHidden(show));

    if (genreFilter) {
      const gfNormalized = normalizeText(genreFilter);
      result = result.filter((show) => {
        const genres = Array.isArray(show.genres) ? show.genres : String(show.genres || '').split(',');
        return genres.some((genre) => {
          const gnNormalized = normalizeText(genre);
          if (gnNormalized === gfNormalized) return true;
          // Equivalencias canónicas comunes entre cine y TV en TMDB
          if (gfNormalized === 'accion' && gnNormalized === 'accion y aventura') return true;
          if (gfNormalized === 'suspenso' && (gnNormalized === 'suspense' || gnNormalized === 'misterio')) return true;
          if (gfNormalized === 'ciencia ficcion' && gnNormalized === 'ciencia ficcion y fantasia') return true;
          if (gfNormalized === 'belica' && (gnNormalized === 'guerra' || gnNormalized === 'belica y politica')) return true;
          if (gfNormalized === 'infantil' && gnNormalized === 'kids') return true;
          return false;
        });
      });
    }
    if (yearFilter !== null) result = result.filter((show) => Number(show.year) === yearFilter);
    if (sortBy === 'rating') result = [...result].sort((a, b) => (b.rating || 0) - (a.rating || 0));
    else if (sortBy === 'anio') result = [...result].sort((a, b) => (Number(b.year) || 0) - (Number(a.year) || 0));
    else if (sortBy === 'az') result = [...result].sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'es'));

    return result;
  }, [isShowHidden, shows, genreFilter, yearFilter, sortBy]);

  const resetFilters = () => { onGenreFilter(null); onYearFilter(null); onSortBy('recientes'); };

  // Si se selecciona un género y aún no hay obras en memoria local, solicitar lote inmediatamente
  useEffect(() => {
    if (genreFilter && filteredShows.length === 0 && hasMore && !isLoadingMore) {
      void Promise.resolve(onLoadMore(false));
    }
  }, [genreFilter, filteredShows.length, hasMore, isLoadingMore, onLoadMore]);

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

      {nativeShell ? (
        <>
          <div className="native-explore-toolbar" aria-label="Filtros del catálogo">
            <button
              type="button"
              className={`native-explore-filter-trigger ${activeFilterCount > 0 ? 'is-active' : ''}`}
              onClick={() => {
                nativeHaptic();
                setMobileFiltersOpen(true);
              }}
            >
              <SlidersHorizontal size={16} />
              <span>Filtros</span>
              {activeFilterCount > 0 && <span className="native-filter-count">{activeFilterCount}</span>}
            </button>
            {genreFilter && <span className="native-filter-chip">{genreFilter}</span>}
            {yearFilter !== null && <span className="native-filter-chip">{yearFilter}</span>}
            {sortBy !== 'recientes' && <span className="native-filter-chip">{sortBy === 'rating' ? 'Rating' : sortBy === 'anio' ? 'Más nuevas' : 'A → Z'}</span>}
          </div>

          {mobileFiltersOpen && (
            <>
              <button
                type="button"
                className="native-explore-filter-backdrop"
                aria-label="Cerrar filtros"
                onClick={() => setMobileFiltersOpen(false)}
              />
              <section className="native-explore-filter-sheet" role="dialog" aria-modal="true" aria-label="Filtros del catálogo">
                <div className="native-sheet-handle" />
                <div className="native-filter-sheet-heading">
                  <div>
                    <p>Explorar</p>
                    <h3>Filtros</h3>
                  </div>
                  <button type="button" onClick={() => setMobileFiltersOpen(false)} aria-label="Cerrar filtros"><X size={18} /></button>
                </div>

                <div className="native-filter-sheet-controls">
                  <FilterMenu
                    ariaLabel="Filtrar por género"
                    icon={<ListFilter size={14} />}
                    value={genreFilter || ''}
                    placeholder="Todos los géneros"
                    options={[{ value: '', label: 'Todos los géneros' }, ...validGenres.map((genre) => ({
                      value: genre,
                      label: genre,
                    }))]}
                    onChange={(value) => onGenreFilter(value || null)}
                  />
                  <CatalogFilters years={availableYears} year={yearFilter} onYear={onYearFilter} sort={sortBy} onSort={onSortBy} />
                </div>

                <div className="native-filter-sheet-actions">
                  <button type="button" className="native-filter-reset" onClick={resetFilters} disabled={activeFilterCount === 0}>
                    Restablecer
                  </button>
                  <button type="button" className="native-filter-apply" onClick={() => { nativeHaptic(); setMobileFiltersOpen(false); }}>
                    Ver {filteredShows.length} {filteredShows.length === 1 ? 'título' : 'títulos'}
                  </button>
                </div>
              </section>
            </>
          )}
        </>
      ) : (
        <div className="catalog-toolbar catalog-toolbar--explore" aria-label="Filtros del catálogo">
          <FilterMenu
            ariaLabel="Filtrar por género"
            icon={<ListFilter size={14} />}
            value={genreFilter || ''}
            placeholder="Todos los géneros"
            options={[{ value: '', label: 'Todos los géneros' }, ...validGenres.map((genre) => ({
              value: genre,
              label: genre,
            }))]}
            onChange={(value) => onGenreFilter(value || null)}
          />
          <CatalogFilters years={availableYears} year={yearFilter} onYear={onYearFilter} sort={sortBy} onSort={onSortBy} />
          {genreFilter && <button type="button" className="filter-clear" onClick={() => onGenreFilter(null)}>Quitar género</button>}
        </div>
      )}

      {filteredShows.length === 0 ? (
        isLoadingMore ? (
          <div className="catalog-loading py-20 text-center" role="status">
            <div className="inline-block h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <p className="mt-3 text-sm text-zinc-400">Cargando títulos de {genreFilter || 'catálogo'}…</p>
          </div>
        ) : (
          <div className="catalog-empty" role="status">
            <Film size={38} aria-hidden="true" />
            <div><strong>No encontramos títulos con esos filtros.</strong><p className="mt-1 text-xs text-zinc-500">Prueba otra combinación o vuelve al catálogo completo.</p></div>
            <button type="button" onClick={resetFilters}>Restablecer filtros</button>
          </div>
        )
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
