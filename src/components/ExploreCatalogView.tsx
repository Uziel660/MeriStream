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
  onHoverMedia: (m: Show | null) => void;
}

export const ExploreCatalogView: React.FC<ExploreCatalogViewProps> = ({
  shows,
  allGenresList,
  showsCountByGenre,
  genreFilter,
  onGenreFilter,
  yearFilter,
  onYearFilter,
  sortBy,
  onSortBy,
  catalogPageSize,
  onLoadMore,
  availableYears,
  onSelectMedia,
  onHoverMedia,
}) => {
  const { isGenreHidden } = useHiddenGenres();

  // Géneros válidos (excluir categorías meta + ocultos por admin)
  const validGenres = useMemo(() => {
    return allGenresList
      .filter((g) => {
        const clean = g.trim();
        if (!clean) return false;
        const low = clean.toLowerCase();
        if (low === 'multimedia' || low === 'anime' || low === 'película' || low === 'serie') return false;
        if (isGenreHidden(clean)) return false;
        return true;
      })
      .sort((a, b) => (showsCountByGenre[b.toLowerCase()] || 0) - (showsCountByGenre[a.toLowerCase()] || 0));
  }, [allGenresList, showsCountByGenre, isGenreHidden]);

  // Shows filtrados por género y año
  const filteredShows = useMemo(() => {
    let result = shows;

    if (genreFilter) {
      const gf = genreFilter.toLowerCase();
      result = result.filter((s) => {
        const genres = Array.isArray(s.genres) ? s.genres : String(s.genres || '').split(',');
        return genres.some((g) => g.trim().toLowerCase() === gf);
      });
    }

    if (yearFilter !== null) {
      result = result.filter((s) => Number(s.year) === yearFilter);
    }

    if (sortBy === 'rating') result = [...result].sort((a, b) => (b.rating || 0) - (a.rating || 0));
    else if (sortBy === 'anio') result = [...result].sort((a, b) => (Number(b.year) || 0) - (Number(a.year) || 0));
    else if (sortBy === 'az') result = [...result].sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'es'));

    return result;
  }, [shows, genreFilter, yearFilter, sortBy]);

  return (
    <section className="space-y-5">
      {/* ENCABEZADO */}
      <div className="flex items-center justify-between border-b border-zinc-800/80 pb-3">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/10 border border-amber-500/30">
            <Grid3X3 size={16} className="text-amber-400" />
          </div>
          <div>
            <h3 className="font-display text-xl sm:text-2xl font-bold text-white tracking-tight">
              Explorar Catálogo
            </h3>
            <p className="text-[11px] text-zinc-500 mt-0.5">
              Filtra por género, año o simplemente navega todo el catálogo
            </p>
          </div>
        </div>
        <span className="font-mono text-xs text-zinc-500">
          {filteredShows.length} {filteredShows.length === 1 ? 'obra' : 'obras'}
        </span>
      </div>

      {/* FILTROS: GÉNERO (dropdown) + AÑO + ORDEN */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Dropdown de género */}
        <div className="relative">
          <ListFilter size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" />
          <select
            value={genreFilter ?? ''}
            onChange={(e) => onGenreFilter(e.target.value || null)}
            className="appearance-none pl-8 pr-7 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-200 focus:outline-none focus:border-amber-500/60 cursor-pointer"
            aria-label="Filtrar por género"
          >
            <option value="">Todos los géneros</option>
            {validGenres.map((g) => {
              const count = showsCountByGenre[g.toLowerCase()] || 0;
              return (
                <option key={g} value={g}>{g}{count ? ` (${count})` : ''}</option>
              );
            })}
          </select>
        </div>

        <CatalogFilters
          years={availableYears}
          year={yearFilter}
          onYear={(y) => { onYearFilter(y); }}
          sort={sortBy}
          onSort={(s) => { onSortBy(s); }}
        />
      </div>

      {/* GRID DE SHOWS */}
      {filteredShows.length === 0 ? (
        <div className="py-16 text-center space-y-3">
          <Film size={36} className="mx-auto text-zinc-600" />
          <p className="text-sm text-zinc-400 font-medium">
            No se encontraron títulos con estos filtros.
          </p>
          <button
            type="button"
            onClick={() => { onGenreFilter(null); onYearFilter(null); onSortBy('recientes'); }}
            className="text-xs text-amber-400 hover:underline font-semibold"
          >
            Restablecer filtros
          </button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4 sm:gap-5">
            {filteredShows.slice(0, catalogPageSize).map((item) => (
              <MediaCard
                key={item.id}
                media={item}
                onSelectMedia={onSelectMedia}
                onHover={onHoverMedia}
              />
            ))}
          </div>
          {filteredShows.length > catalogPageSize && (
            <div className="flex justify-center pt-4">
              <button
                type="button"
                onClick={onLoadMore}
                className="px-6 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-sm font-medium text-zinc-200 border border-zinc-700 transition-colors"
              >
                Cargar más ({filteredShows.length - catalogPageSize} restantes)
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
};
