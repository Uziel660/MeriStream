import React from 'react';
import { Calendar, ArrowDownWideNarrow, X } from 'lucide-react';

export type SortMode = 'recientes' | 'rating' | 'anio' | 'az';

interface CatalogFiltersProps {
  years: number[];
  year: number | null;
  onYear: (y: number | null) => void;
  sort: SortMode;
  onSort: (s: SortMode) => void;
  className?: string;
}

const SORT_LABELS: Record<SortMode, string> = {
  recientes: 'Recientes',
  rating: 'Mejor rating',
  anio: 'Más nuevas',
  az: 'A → Z',
};

export const CatalogFilters: React.FC<CatalogFiltersProps> = ({ years, year, onYear, sort, onSort, className = 'contents' }) => (
  <div className={className}>
    <label className="filter-control">
      <Calendar size={14} aria-hidden="true" />
      <span className="sr-only">Filtrar por año</span>
      <select value={year ?? ''} onChange={(e) => onYear(e.target.value ? Number(e.target.value) : null)} className="filter-select" aria-label="Filtrar por año">
        <option value="">Todos los años</option>
        {years.map((y) => <option key={y} value={y}>{y}</option>)}
      </select>
    </label>

    <label className="filter-control">
      <ArrowDownWideNarrow size={14} aria-hidden="true" />
      <span className="sr-only">Ordenar catálogo</span>
      <select value={sort} onChange={(e) => onSort(e.target.value as SortMode)} className="filter-select" aria-label="Ordenar catálogo">
        {(Object.keys(SORT_LABELS) as SortMode[]).map((key) => <option key={key} value={key}>{SORT_LABELS[key]}</option>)}
      </select>
    </label>

    {(year !== null || sort !== 'recientes') && (
      <button type="button" onClick={() => { onYear(null); onSort('recientes'); }} className="filter-clear" aria-label="Restablecer filtros de año y orden">
        <X size={13} /> Limpiar
      </button>
    )}
  </div>
);
