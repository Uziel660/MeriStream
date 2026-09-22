import React from 'react';
import { Calendar, ArrowDownWideNarrow, X } from 'lucide-react';
import { FilterMenu } from './FilterMenu';

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
    <FilterMenu
      ariaLabel="Filtrar por año"
      icon={<Calendar size={14} />}
      value={year === null ? '' : String(year)}
      placeholder="Todos los años"
      options={[{ value: '', label: 'Todos los años' }, ...years.map((value) => ({ value: String(value), label: String(value) }))]}
      onChange={(value) => onYear(value ? Number(value) : null)}
    />

    <FilterMenu
      ariaLabel="Ordenar catálogo"
      icon={<ArrowDownWideNarrow size={14} />}
      value={sort}
      placeholder="Recientes"
      active={sort !== 'recientes'}
      options={(Object.keys(SORT_LABELS) as SortMode[]).map((value) => ({ value, label: SORT_LABELS[value] }))}
      onChange={(value) => onSort(value as SortMode)}
    />

    {(year !== null || sort !== 'recientes') && (
      <button type="button" onClick={() => { onYear(null); onSort('recientes'); }} className="filter-clear" aria-label="Restablecer filtros de año y orden">
        <X size={13} /> Limpiar
      </button>
    )}
  </div>
);
