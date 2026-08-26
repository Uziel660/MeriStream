// src/components/CatalogFilters.tsx
// Barra compacta de filtros del catálogo: Año + Orden. Reutilizable en la
// vista de catálogo (pestañas/búsqueda) y en la sección "Explorar Catálogo".

import React from 'react';
import { Calendar, ArrowDownWideNarrow, X } from 'lucide-react';

export type SortMode = 'recientes' | 'rating' | 'anio' | 'az';

interface CatalogFiltersProps {
  years: number[];
  year: number | null;
  onYear: (y: number | null) => void;
  sort: SortMode;
  onSort: (s: SortMode) => void;
}

const SORT_LABELS: Record<SortMode, string> = {
  recientes: 'Recientes',
  rating: 'Mejor rating',
  anio: 'Más nuevas',
  az: 'A → Z',
};

export const CatalogFilters: React.FC<CatalogFiltersProps> = ({ years, year, onYear, sort, onSort }) => (
  <div className="flex flex-wrap items-center gap-2">
    <div className="relative">
      <Calendar size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" />
      <select
        value={year ?? ''}
        onChange={(e) => onYear(e.target.value ? Number(e.target.value) : null)}
        className="appearance-none pl-8 pr-7 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-200 focus:outline-none focus:border-amber-500/60 cursor-pointer"
        aria-label="Filtrar por año"
      >
        <option value="">Todos los años</option>
        {years.map((y) => (
          <option key={y} value={y}>{y}</option>
        ))}
      </select>
    </div>

    <div className="relative">
      <ArrowDownWideNarrow size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" />
      <select
        value={sort}
        onChange={(e) => onSort(e.target.value as SortMode)}
        className="appearance-none pl-8 pr-7 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-200 focus:outline-none focus:border-amber-500/60 cursor-pointer"
        aria-label="Ordenar catálogo"
      >
        {(Object.keys(SORT_LABELS) as SortMode[]).map((k) => (
          <option key={k} value={k}>{SORT_LABELS[k]}</option>
        ))}
      </select>
    </div>

    {(year !== null || sort !== 'recientes') && (
      <button
        type="button"
        onClick={() => { onYear(null); onSort('recientes'); }}
        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-[11px] text-zinc-400 hover:text-white hover:border-zinc-600 transition-colors"
      >
        <X size={11} />
        Limpiar
      </button>
    )}
  </div>
);
