import React, { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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

interface FilterMenuPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
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
  const [menuPosition, setMenuPosition] = useState<FilterMenuPosition | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value);

  const closeMenu = useCallback(() => {
    setIsOpen(false);
    setMenuPosition(null);
  }, []);

  const updateMenuPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger || typeof window === 'undefined') return;

    const bounds = trigger.getBoundingClientRect();
    const viewportWidth = window.visualViewport?.width || window.innerWidth;
    const viewportHeight = window.visualViewport?.height || window.innerHeight;
    const gutter = 12;
    const gap = 8;
    const width = Math.min(bounds.width, Math.max(1, viewportWidth - gutter * 2));
    const left = Math.min(Math.max(gutter, bounds.left), viewportWidth - gutter - width);
    const maxDesiredHeight = Math.min(288, Math.max(96, viewportHeight - gutter * 2));
    const estimatedHeight = Math.min(maxDesiredHeight, Math.max(44, options.length * 36 + 12));
    const spaceBelow = viewportHeight - bounds.bottom - gap - gutter;
    const spaceAbove = bounds.top - gap - gutter;
    const opensAbove = spaceBelow < estimatedHeight && spaceAbove > spaceBelow;

    if (spaceBelow < 96 && spaceAbove < 96) {
      setMenuPosition({ top: gutter, left, width, maxHeight: Math.max(96, viewportHeight - gutter * 2) });
      return;
    }

    const maxHeight = Math.max(96, Math.min(maxDesiredHeight, opensAbove ? spaceAbove : spaceBelow));
    const top = opensAbove
      ? Math.max(gutter, bounds.top - gap - maxHeight)
      : bounds.bottom + gap;
    setMenuPosition({ top, left, width, maxHeight });
  }, [options.length]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      closeMenu();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [closeMenu]);

  useEffect(() => {
    if (!isOpen) return;
    const handleViewportChange = () => updateMenuPosition();
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);
    window.visualViewport?.addEventListener('resize', handleViewportChange);
    window.visualViewport?.addEventListener('scroll', handleViewportChange);
    return () => {
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
      window.visualViewport?.removeEventListener('resize', handleViewportChange);
      window.visualViewport?.removeEventListener('scroll', handleViewportChange);
    };
  }, [isOpen, updateMenuPosition]);

  const menu = isOpen && menuPosition && typeof document !== 'undefined'
    ? createPortal(
      <div
        ref={menuRef}
        className="filter-menu filter-menu--portal"
        role="listbox"
        aria-label={ariaLabel}
        style={{
          position: 'fixed',
          // Menus are portaled out of sheets and dialogs, so keep them above
          // every app overlay even on older Android WebViews.
          zIndex: 2147483647,
          top: menuPosition.top,
          left: menuPosition.left,
          width: menuPosition.width,
          minWidth: menuPosition.width,
          maxWidth: menuPosition.width,
          maxHeight: menuPosition.maxHeight,
        }}
      >
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
                closeMenu();
              }}
            >
              <span>{option.label}</span>
              {isSelected && <Check size={14} aria-hidden="true" />}
            </button>
          );
        })}
        {options.length === 0 && <span className="filter-menu-empty">No hay opciones disponibles</span>}
      </div>,
      document.body,
    )
    : null;

  return (
    <div ref={rootRef} className={`filter-control filter-menu-wrap ${className}`.trim()}>
      <button
        ref={triggerRef}
        type="button"
        className={`filter-trigger${active ? ' is-active' : ''}`}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        onClick={() => {
          if (isOpen) closeMenu();
          else {
            updateMenuPosition();
            setIsOpen(true);
          }
        }}
      >
        <span className="filter-trigger-icon" aria-hidden="true">{icon}</span>
        <span className="filter-trigger-label">{selected?.label || placeholder}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {menu}
    </div>
  );
};
