import React, { useMemo, useState, useCallback } from 'react';
import { Eye, EyeOff, Trash2, X, Film } from 'lucide-react';
import { useHiddenGenres } from '../hooks/useHiddenGenres';
import type { Show } from '../types';

interface GenresManagerProps {
  shows: Show[];
}

/**
 * Panel de administración de géneros: permite al admin ocultar/mostrar
 * géneros en toda la plataforma. Al hacer clic en un género se muestran
 * las obras que pertenecen a ese género.
 */
export const GenresManager: React.FC<GenresManagerProps> = ({ shows }) => {
  const { hiddenGenres, toggleGenre, hiddenCount } = useHiddenGenres();
  const [search, setSearch] = useState('');
  const [selectedGenre, setSelectedGenre] = useState<string | null>(null);

  // Calcular todos los géneros únicos y sus conteos
  const allGenres = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of shows) {
      const genres = Array.isArray(s.genres)
        ? s.genres
        : String(s.genres || '').split(',').map((g) => g.trim());
      for (const g of genres) {
        const clean = g.trim();
        if (!clean) continue;
        counts.set(clean, (counts.get(clean) || 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([genre, count]) => ({ genre, count }));
  }, [shows]);

  // Obras del género seleccionado
  const selectedGenreShows = useMemo(() => {
    if (!selectedGenre) return [];
    const gLower = selectedGenre.toLowerCase();
    return shows.filter((s) => {
      const genres = Array.isArray(s.genres)
        ? s.genres
        : String(s.genres || '').split(',').map((g) => g.trim());
      return genres.some((g) => g.trim().toLowerCase() === gLower);
    });
  }, [shows, selectedGenre]);

  // Filtrar por búsqueda
  const filtered = useMemo(() => {
    if (!search.trim()) return allGenres;
    const q = search.toLowerCase().trim();
    return allGenres.filter((g) => g.genre.toLowerCase().includes(q));
  }, [allGenres, search]);

  // Auto-ocultar géneros sin contenido
  const emptyGenres = useMemo(
    () => allGenres.filter((g) => g.count === 0 && !hiddenGenres.has(g.genre.toLowerCase())),
    [allGenres, hiddenGenres]
  );

  const handleAutoHideEmpty = useCallback(() => {
    for (const g of emptyGenres) {
      toggleGenre(g.genre);
    }
  }, [emptyGenres, toggleGenre]);

  const visibleCount = Math.max(0, allGenres.length - hiddenCount);

  return (
    <div className="space-y-4">
      {/* Encabezado */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-bold text-white flex items-center gap-2">
            Gestión de Géneros
          </h3>
          <p className="text-xs text-zinc-400 mt-0.5">
            Controla qué géneros se muestran en filtros, dropdowns y detalle de obras.
            Haz clic en un género para ver sus obras.
          </p>
        </div>
        <span className="text-xs text-zinc-500 font-mono">
          {visibleCount} visibles / {allGenres.length} totales
        </span>
      </div>

      {/* Barra de búsqueda + auto-ocultar vacíos */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar género..."
          className="flex-1 max-w-xs px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-amber-500/60"
        />
        {emptyGenres.length > 0 && (
          <button
            type="button"
            onClick={handleAutoHideEmpty}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-300 hover:text-white hover:border-zinc-700 transition-colors"
            title={`Ocultar ${emptyGenres.length} género(s) sin contenido`}
          >
            <Trash2 size={12} />
            Ocultar vacíos ({emptyGenres.length})
          </button>
        )}
      </div>

      <div className="flex gap-4">
        {/* Lista de géneros */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 divide-y divide-zinc-800/60 max-h-[60vh] overflow-y-auto flex-1">
          {filtered.length === 0 ? (
            <div className="p-8 text-center text-xs text-zinc-500">
              No se encontraron géneros "{search}"
            </div>
          ) : (
            filtered.map(({ genre, count }) => {
              const isHidden = hiddenGenres.has(genre.toLowerCase());
              const isEmpty = count === 0;
              const isSelected = selectedGenre === genre;

              return (
                <div
                  key={genre}
                  className={`flex items-center justify-between px-4 py-2.5 transition-colors cursor-pointer ${
                    isSelected
                      ? 'bg-amber-500/10 border-l-2 border-amber-400'
                      : isHidden
                        ? 'bg-zinc-950/60 opacity-60 hover:opacity-80'
                        : 'hover:bg-zinc-900/40'
                  }`}
                  onClick={() => setSelectedGenre(isSelected ? null : genre)}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); toggleGenre(genre); }}
                      className={`p-1 rounded-md transition-colors shrink-0 ${
                        isHidden
                          ? 'text-zinc-600 hover:text-amber-400 hover:bg-amber-500/10'
                          : 'text-amber-400 hover:text-zinc-400 hover:bg-zinc-800'
                      }`}
                      title={isHidden ? 'Mostrar género' : 'Ocultar género'}
                    >
                      {isHidden ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                    <span className={`text-xs font-medium ${isHidden ? 'text-zinc-500 line-through' : 'text-zinc-200'}`}>
                      {genre}
                    </span>
                    {isEmpty && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500 font-mono">
                        vacío
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-[11px] font-mono text-zinc-500">
                      {count} {count === 1 ? 'obra' : 'obras'}
                    </span>
                    <div
                      className={`w-2 h-2 rounded-full ${
                        isHidden ? 'bg-zinc-600' : 'bg-emerald-500'
                      }`}
                      title={isHidden ? 'Oculto' : 'Visible'}
                    />
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Panel lateral: obras del género seleccionado */}
        {selectedGenre && (
          <div className="w-80 shrink-0 rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden flex flex-col max-h-[60vh]">
            <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800 bg-zinc-900/50">
              <div className="min-w-0">
                <h4 className="text-xs font-bold text-white truncate">{selectedGenre}</h4>
                <p className="text-[10px] text-zinc-500">
                  {selectedGenreShows.length} {selectedGenreShows.length === 1 ? 'obra' : 'obras'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedGenre(null)}
                className="p-1 rounded-md text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
              >
                <X size={14} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
              {selectedGenreShows.length === 0 ? (
                <div className="py-8 text-center text-xs text-zinc-500">
                  No hay obras con este género
                </div>
              ) : (
                selectedGenreShows.map((show) => (
                  <div
                    key={show.id}
                    className="flex items-center gap-2.5 p-2 rounded-lg bg-zinc-900/40 border border-zinc-800/60 hover:bg-zinc-900/70 transition-colors"
                  >
                    {show.poster_url ? (
                      <img
                        src={show.poster_url}
                        alt={show.title}
                        className="w-8 h-11 object-cover rounded border border-zinc-800 shrink-0"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-8 h-11 rounded bg-zinc-800 flex items-center justify-center shrink-0">
                        <Film size={12} className="text-zinc-600" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-[11px] font-semibold text-zinc-200 truncate">{show.title}</p>
                      <p className="text-[10px] text-zinc-500">
                        {show.category || 'Sin categoría'}{show.year ? ` · ${show.year}` : ''}
                      </p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
