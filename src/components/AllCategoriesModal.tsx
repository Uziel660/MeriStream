// src/components/AllCategoriesModal.tsx
import React, { useState, useMemo } from 'react';
import { X, Search, Film, Tv, Flame } from 'lucide-react';

interface AllCategoriesModalProps {
  isOpen: boolean;
  onClose: () => void;
  allGenres: string[];
  activeFilter: string;
  onSelectCategory: (category: string) => void;
  showsCountByGenre?: Record<string, number>;
}

export const AllCategoriesModal: React.FC<AllCategoriesModalProps> = ({
  isOpen,
  onClose,
  allGenres,
  activeFilter,
  onSelectCategory,
  showsCountByGenre = {},
}) => {
  const [filterQuery, setFilterQuery] = useState('');

  const filteredGenres = useMemo(() => {
    if (!filterQuery.trim()) return allGenres;
    const q = filterQuery.toLowerCase().trim();
    return allGenres.filter((g) => g.toLowerCase().includes(q));
  }, [allGenres, filterQuery]);

  if (!isOpen) return null;

  const handleSelect = (genreId: string) => {
    onSelectCategory(genreId);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-2xl max-h-[85vh] flex flex-col rounded-2xl bg-zinc-950 border border-zinc-800 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* MODAL HEADER */}
        <div className="flex items-center justify-between p-5 sm:p-6 border-b border-zinc-800/80 bg-zinc-900/40">
          <div>
            <h3 className="font-display text-lg font-bold text-white tracking-tight">
              Todas las Categorías & Géneros
            </h3>
            <p className="text-xs text-zinc-400 mt-0.5">
              Sincronizadas desde las APIs de Anime, Cine y Series
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-full text-zinc-400 hover:text-white hover:bg-zinc-800 transition"
          >
            <X size={18} />
          </button>
        </div>

        {/* SEARCH FILTER */}
        <div className="p-4 sm:p-5 border-b border-zinc-800/60 bg-zinc-900/20">
          <div className="relative">
            <Search
              size={15}
              className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none"
            />
            <input
              type="text"
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              placeholder="Filtrar géneros (Terror, Isekai, Acción, Suspenso...)"
              className="w-full rounded-xl bg-zinc-900/90 border border-zinc-800 text-xs text-white placeholder-zinc-500 pl-10 pr-4 py-2.5 focus:border-zinc-600 focus:outline-none transition shadow-inner font-normal"
              autoFocus
            />
          </div>
        </div>

        {/* MAIN QUICK CATEGORIES */}
        <div className="px-5 pt-4 pb-2">
          <span className="text-[11px] font-mono uppercase tracking-wider text-zinc-500 font-semibold block mb-2">
            Categorías Principales
          </span>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <button
              type="button"
              onClick={() => handleSelect('all')}
              className={`flex items-center justify-center p-2.5 rounded-xl border text-xs font-medium transition-all ${
                activeFilter === 'all'
                  ? 'bg-white text-zinc-950 border-white font-semibold shadow-sm'
                  : 'bg-zinc-900/70 border-zinc-800 text-zinc-300 hover:border-zinc-700 hover:text-white'
              }`}
            >
              <span>Todos los Títulos</span>
            </button>
            <button
              type="button"
              onClick={() => handleSelect('anime')}
              className={`flex items-center justify-center gap-1.5 p-2.5 rounded-xl border text-xs font-medium transition-all ${
                activeFilter === 'anime'
                  ? 'bg-white text-zinc-950 border-white font-semibold shadow-sm'
                  : 'bg-zinc-900/70 border-zinc-800 text-zinc-300 hover:border-zinc-700 hover:text-white'
              }`}
            >
              <Flame size={14} />
              <span>Anime</span>
            </button>
            <button
              type="button"
              onClick={() => handleSelect('movie')}
              className={`flex items-center justify-center gap-1.5 p-2.5 rounded-xl border text-xs font-medium transition-all ${
                activeFilter === 'movie'
                  ? 'bg-white text-zinc-950 border-white font-semibold shadow-sm'
                  : 'bg-zinc-900/70 border-zinc-800 text-zinc-300 hover:border-zinc-700 hover:text-white'
              }`}
            >
              <Film size={14} />
              <span>Películas</span>
            </button>
            <button
              type="button"
              onClick={() => handleSelect('series')}
              className={`flex items-center justify-center gap-1.5 p-2.5 rounded-xl border text-xs font-medium transition-all ${
                activeFilter === 'series'
                  ? 'bg-white text-zinc-950 border-white font-semibold shadow-sm'
                  : 'bg-zinc-900/70 border-zinc-800 text-zinc-300 hover:border-zinc-700 hover:text-white'
              }`}
            >
              <Tv size={14} />
              <span>Series</span>
            </button>
          </div>
        </div>

        {/* GENRES GRID */}
        <div className="p-5 overflow-y-auto flex-1 max-h-[50vh] space-y-3">
          <span className="text-[11px] font-mono uppercase tracking-wider text-zinc-500 font-semibold block">
            Géneros ({filteredGenres.length})
          </span>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {filteredGenres.map((genre) => {
              const genreKey = genre.toLowerCase();
              const isSelected =
                activeFilter.toLowerCase() === genreKey ||
                activeFilter.toLowerCase() === genre.toLowerCase();
              const count = showsCountByGenre[genreKey] || 0;

              return (
                <button
                  key={genre}
                  type="button"
                  onClick={() => handleSelect(genre)}
                  className={`flex items-center justify-between p-2.5 rounded-xl border text-xs text-left transition-all ${
                    isSelected
                      ? 'bg-white text-zinc-950 border-white font-semibold shadow-sm'
                      : 'bg-zinc-900/50 border-zinc-800/80 text-zinc-300 hover:bg-zinc-850 hover:border-zinc-700 hover:text-white'
                  }`}
                >
                  <span className="truncate pr-1">{genre}</span>
                  {count > 0 && (
                    <span
                      className={`text-[10px] font-mono px-1.5 py-0.5 rounded-full ${
                        isSelected ? 'bg-zinc-200 text-zinc-900' : 'bg-zinc-800 text-zinc-400'
                      }`}
                    >
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {filteredGenres.length === 0 && (
            <div className="py-12 text-center text-zinc-500 text-xs">
              No se encontró ninguna categoría con el término "{filterQuery}".
            </div>
          )}
        </div>

        {/* FOOTER */}
        <div className="p-4 border-t border-zinc-800/80 bg-zinc-900/40 flex items-center justify-between text-xs text-zinc-400">
          <span>Selecciona un género para filtrar el catálogo al instante.</span>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 font-medium transition"
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  );
};
