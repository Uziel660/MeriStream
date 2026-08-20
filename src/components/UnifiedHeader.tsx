// src/components/UnifiedHeader.tsx
import React, { useState, useEffect, useRef } from 'react';
import { Search, Shield, X, Clapperboard, ChevronRight, Grid } from 'lucide-react';
import { motion } from 'motion/react';

export interface FilterItem {
  id: string;
  label: string;
}

export const MAIN_QUICK_FILTERS: FilterItem[] = [
  { id: 'all', label: 'Todos' },
  { id: 'anime', label: 'Anime' },
  { id: 'movie', label: 'Películas' },
  { id: 'series', label: 'Series' },
  { id: 'Terror', label: 'Terror' },
  { id: 'Acción', label: 'Acción' },
  { id: 'Fantasía', label: 'Fantasía' },
  { id: 'Ciencia Ficción', label: 'Sci-Fi' },
  { id: 'Suspenso', label: 'Suspenso' },
  { id: 'Shounen', label: 'Shounen' },
  { id: 'Seinen', label: 'Seinen' },
  { id: 'Romance', label: 'Romance' },
];

interface UnifiedHeaderProps {
  onSearchChange: (query: string) => void;
  onOpenAdmin: () => void;
  activeFilter: string;
  onSelectCategory: (category: string) => void;
  onOpenAllCategories: () => void;
}

export const UnifiedHeader: React.FC<UnifiedHeaderProps> = ({
  onSearchChange,
  onOpenAdmin,
  activeFilter,
  onSelectCategory,
  onOpenAllCategories,
}) => {
  const [query, setQuery] = useState('');
  const [isScrolled, setIsScrolled] = useState(false);
  const [workerCount, setWorkerCount] = useState(0);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Monitor scroll for navbar background blur elevation
  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 15);
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Worker status polling
  useEffect(() => {
    const checkWorkers = async () => {
      try {
        const res = await fetch('/api/v1/worker/jobs');
        if (res.ok) {
          const jobs = await res.json();
          const active = jobs.filter((j: any) => j.status === 'running' || j.status === 'pending').length;
          setWorkerCount(active);
        }
      } catch {}
    };
    checkWorkers();
    const interval = setInterval(checkWorkers, 4000);
    return () => clearInterval(interval);
  }, []);

  // Search debounce
  useEffect(() => {
    const timer = setTimeout(() => {
      onSearchChange(query);
    }, 250);
    return () => clearTimeout(timer);
  }, [query, onSearchChange]);

  return (
    <header
      id="main-unified-header"
      className={`sticky top-0 z-40 transition-all duration-300 ${
        isScrolled
          ? 'bg-zinc-950/95 backdrop-blur-xl border-b border-zinc-800 shadow-2xl py-2.5'
          : 'bg-zinc-950/80 backdrop-blur-md border-b border-zinc-850/60 py-3'
      }`}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-8 space-y-2.5">
        
        {/* ROW 1: BRAND LOGO + INTEGRATED COMPACT SEARCH + ADMIN PANEL */}
        <div className="flex items-center justify-between gap-3 sm:gap-6">
          
          {/* LOGO & BRAND */}
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              onSelectCategory('all');
            }}
            className="flex items-center gap-2.5 select-none group shrink-0"
          >
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-amber-500 text-black shadow-md shadow-amber-500/20 transition-transform duration-200 group-hover:scale-105">
              <Clapperboard size={18} className="stroke-[2.2]" />
            </div>
            <div className="flex flex-col">
              <span className="text-lg font-bold tracking-tight text-white leading-none">
                NITI<span className="text-amber-400">FLIX</span>
              </span>
              <span className="text-[10px] tracking-wider text-zinc-400 font-medium mt-0.5">
                Cinema & Anime
              </span>
            </div>
          </a>

          {/* SEARCH BAR (INTEGRADA EN LA MISMA BARRA) */}
          <div className="relative flex-1 max-w-md">
            <Search
              size={14}
              className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none"
            />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar título, saga, actor o género..."
              className="w-full rounded-full bg-zinc-900/90 border border-zinc-800 text-xs text-white placeholder-zinc-500 pl-9 pr-8 py-2 focus:border-amber-500/70 focus:outline-none transition shadow-inner font-normal"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Limpiar búsqueda"
                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-white p-0.5 rounded-full hover:bg-zinc-800 transition"
              >
                <X size={13} />
              </button>
            )}
          </div>

          {/* ADMIN & WORKER ACTIVITY BUTTON */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onOpenAdmin}
              id="open-admin-panel-btn"
              className="flex items-center gap-2 px-3 sm:px-3.5 py-2 rounded-full bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-300 hover:text-white transition-all shadow-sm group"
              title="Panel de Control e Ingesta"
            >
              <Shield size={15} className="text-amber-400" />
              <span className="hidden sm:inline text-xs font-semibold">Panel Admin</span>

              {workerCount > 0 && (
                <span className="flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.2 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
                  {workerCount}
                </span>
              )}
            </button>
          </div>
        </div>

        {/* ROW 2: CATEGORY & GENRES PILL BAR (INTEGRADA DIRECTAMENTE EN LA BARRA SUPERIOR) */}
        <div className="flex items-center justify-between gap-3 pt-1 border-t border-zinc-900/70">
          
          <div
            ref={scrollContainerRef}
            className="flex items-center gap-1.5 overflow-x-auto scrollbar-none py-0.5"
          >
            {MAIN_QUICK_FILTERS.map((filter) => {
              const isActive =
                activeFilter.toLowerCase() === filter.id.toLowerCase() ||
                (filter.id === 'all' && activeFilter === 'all');

              return (
                <button
                  key={filter.id}
                  type="button"
                  onClick={() => onSelectCategory(filter.id)}
                  className={`relative px-3 py-1.5 rounded-full text-xs font-medium select-none transition-colors duration-150 shrink-0 ${
                    isActive
                      ? 'text-black font-semibold'
                      : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
                  }`}
                >
                  {isActive && (
                    <motion.div
                      layoutId="unifiedActiveFilterPill"
                      className="absolute inset-0 rounded-full bg-amber-400 shadow-sm"
                      transition={{ type: 'spring', bounce: 0.15, duration: 0.35 }}
                    />
                  )}
                  <span className="relative z-10">{filter.label}</span>
                </button>
              );
            })}

            {/* BUTTON TO OPEN ALL CATEGORIES MODAL */}
            <button
              type="button"
              onClick={onOpenAllCategories}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-zinc-300 hover:text-white bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 transition-colors shrink-0 ml-1 select-none"
            >
              <Grid size={13} className="text-zinc-400" />
              <span>Ver todas las categorías</span>
              <ChevronRight size={12} className="text-zinc-500" />
            </button>
          </div>
        </div>

      </div>
    </header>
  );
};
