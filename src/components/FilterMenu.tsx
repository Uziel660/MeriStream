import React, { type ReactNode, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

export interface FilterMenuOption {
  value: string;
  label: string;
}

interface FilterMenuProps {
  ariaLabel: string;
  icon: ReactNode;
  value: string;
  placeholder: string;
  options: FilterMenuOption[];
  onChange: (value: string) => void;
  active?: boolean;
  className?: string;
}

/** Compact menu used by browse filters instead of the browser's native list. */
export const FilterMenu: React.FC<FilterMenuProps> = ({
  ariaLabel,
  icon,
  value,
  placeholder,
  options,
  onChange,
  active = Boolean(value),
  className = '',
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setIsOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  return (
    <div ref={rootRef} className={`filter-control filter-menu-wrap ${className}`.trim()}>
      <button
        type="button"
        className={`filter-trigger${active ? ' is-active' : ''}`}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
      >
        <span className="filter-trigger-icon" aria-hidden="true">{icon}</span>
        <span className="filter-trigger-label">{selected?.label || placeholder}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>

      {isOpen && (
        <div className="filter-menu" role="listbox" aria-label={ariaLabel}>
          {options.map((option) => {
            const isSelected = option.value === value;
            return (
              <button
                key={option.value || 'all'}
                type="button"
                role="option"
                aria-selected={isSelected}
                className={`filter-option${isSelected ? ' is-selected' : ''}`}
                onClick={() => {
                  onChange(option.value);
                  setIsOpen(false);
                }}
              >
                <span>{option.label}</span>
                {isSelected && <Check size={14} aria-hidden="true" />}
              </button>
            );
          })}
          {options.length === 0 && <span className="filter-menu-empty">No hay opciones disponibles</span>}
        </div>
      )}
    </div>
  );
};
