import React, { useState, useEffect, useRef } from 'react';
import { Search, X, Clapperboard, LogOut, LogIn, ChevronDown } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useAuth } from '../contexts/AuthContext';

export interface FilterItem {
  id: string;
  label: string;
}

/** Pestañas fijas: las primeras son categorías principales, el resto géneros rápidos. */
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
  { id: 'Romance', label: 'Romance' },
  { id: 'explore', label: 'Explorar catálogo' },
];

/** Máximo de pestañas visibles sin scroll en pantallas sm+. */
const MAX_VISIBLE_TABS = 7;

const AVATAR_BG_MAP: Record<string, string> = {
  amber: 'bg-amber-500 text-black',
  emerald: 'bg-emerald-500 text-black',
  crimson: 'bg-red-600 text-white',
  indigo: 'bg-indigo-600 text-white',
  rose: 'bg-pink-600 text-white',
  cyan: 'bg-cyan-500 text-black',
};

interface UnifiedHeaderProps {
  onSearchChange: (query: string) => void;
  activeFilter: string;
  onSelectCategory: (category: string) => void;
}

export const UnifiedHeader: React.FC<UnifiedHeaderProps> = ({
  onSearchChange,
  activeFilter,
  onSelectCategory,
}) => {
  const { user, isAuthenticated, openAuthModal, logout, updateAvatar } = useAuth();
  const [query, setQuery] = useState('');
  const [isScrolled, setIsScrolled] = useState(false);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleScroll = () => setIsScrolled(window.scrollY > 15);
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setIsUserMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => onSearchChange(query), 250);
    return () => clearTimeout(timer);
  }, [query, onSearchChange]);

  const avatarBg = user?.avatar && AVATAR_BG_MAP[user.avatar]
    ? AVATAR_BG_MAP[user.avatar]
    : 'bg-amber-500 text-black';

  // Separar pestañas "core" (categorías) de "extra" (explorar)
  const coreTabs = MAIN_QUICK_FILTERS.filter((f) => f.id !== 'explore');
  const exploreTab = MAIN_QUICK_FILTERS.find((f) => f.id === 'explore');

  return (
    <header
      id="main-unified-header"
      className={`sticky top-0 z-40 transition-all duration-300 ${
        isScrolled
          ? 'bg-zinc-950/95 backdrop-blur-xl border-b border-zinc-800 shadow-2xl py-2'
          : 'bg-zinc-950/80 backdrop-blur-md border-b border-zinc-850/60 py-2.5'
      }`}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-8">

        {/* ROW 1: LOGO + SEARCH (full width) + AVATAR */}
        <div className="flex items-center gap-3">

          {/* LOGO */}
          <a
            href="/"
            onClick={(e) => { e.preventDefault(); onSelectCategory('all'); }}
            className="flex items-center gap-2 select-none group shrink-0"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500 text-black shadow-md shadow-amber-500/20 transition-transform duration-200 group-hover:scale-105">
              <Clapperboard size={16} className="stroke-[2.2]" />
            </div>
            <span className="hidden sm:inline text-base font-bold tracking-tight text-white">
              MERI<span className="text-amber-400">STREAM</span>
            </span>
          </a>

          {/* SEARCH BAR — flex-1, full width remaining */}
          <div className="relative flex-1">
            <Search
              size={15}
              className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-400 pointer-events-none"
            />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar título, saga, actor o género..."
              className="w-full rounded-full bg-zinc-900/90 border border-zinc-800 text-sm text-white placeholder-zinc-500 pl-10 pr-9 py-2.5 focus:border-amber-500/70 focus:outline-none transition shadow-inner"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Limpiar búsqueda"
                className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-white p-0.5 rounded-full hover:bg-zinc-800 transition"
              >
                <X size={14} />
              </button>
            )}
          </div>

          {/* AVATAR / AUTH */}
          <div className="shrink-0 relative" ref={userMenuRef}>
            {isAuthenticated && user ? (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setIsUserMenuOpen(!isUserMenuOpen)}
                  className="flex items-center gap-2 p-1.5 pr-2.5 rounded-full bg-zinc-900/90 border border-zinc-800 hover:border-zinc-700 transition shadow-sm group"
                >
                  <div className={`h-7 w-7 rounded-full flex items-center justify-center font-bold text-xs shadow ${avatarBg}`}>
                    {user.username.charAt(0).toUpperCase()}
                  </div>
                  <ChevronDown size={13} className={`text-zinc-500 transition-transform hidden sm:block ${isUserMenuOpen ? 'rotate-180' : ''}`} />
                </button>

                <AnimatePresence>
                  {isUserMenuOpen && (
                    <motion.div
                      initial={{ opacity: 0, y: 10, scale: 0.95 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: 10, scale: 0.95 }}
                      transition={{ duration: 0.15 }}
                      className="absolute right-0 mt-2 w-56 rounded-2xl bg-zinc-950/95 border border-zinc-800 shadow-2xl p-2 z-50 backdrop-blur-xl"
                    >
                      <div className="p-3 border-b border-zinc-850">
                        <p className="text-xs font-semibold text-white truncate">{user.username}</p>
                        <p className="text-[10px] text-zinc-500">Miembro MeriStream</p>
                      </div>
                      <div className="p-2.5">
                        <span className="text-[10px] font-semibold text-zinc-400 uppercase tracking-wider block mb-2">
                          Color de Perfil
                        </span>
                        <div className="flex gap-2">
                          {Object.keys(AVATAR_BG_MAP).map((colorKey) => (
                            <button
                              key={colorKey}
                              type="button"
                              onClick={() => updateAvatar(colorKey)}
                              className={`h-5 w-5 rounded-full ${AVATAR_BG_MAP[colorKey].split(' ')[0]} transition-transform ${
                                user.avatar === colorKey ? 'ring-2 ring-white scale-110' : 'opacity-60 hover:opacity-100'
                              }`}
                            />
                          ))}
                        </div>
                      </div>
                      <div className="border-t border-zinc-850 my-1" />
                      <button
                        type="button"
                        onClick={() => { logout(); setIsUserMenuOpen(false); }}
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-xs font-medium text-red-400 hover:bg-red-950/30 rounded-xl transition"
                      >
                        <LogOut size={14} />
                        <span>Cerrar Sesión</span>
                      </button>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            ) : (
              <button
                type="button"
                onClick={openAuthModal}
                className="flex items-center gap-2 px-3.5 py-2 rounded-full bg-gradient-to-r from-amber-500 to-amber-400 hover:from-amber-400 hover:to-amber-300 text-black font-semibold text-xs shadow-md shadow-amber-500/20 transition-all hover:scale-105 active:scale-95"
              >
                <LogIn size={14} className="stroke-[2.5]" />
                <span className="hidden sm:inline">Ingresar</span>
              </button>
            )}
          </div>
        </div>

        {/* ROW 2: TABS — máx MAX_VISIBLE_TABS visibles, scroll horizontal */}
        <div className="flex items-center justify-between gap-2 pt-2 mt-2 border-t border-zinc-900/70">
          <div
            ref={scrollContainerRef}
            className="flex items-center gap-1.5 overflow-x-auto scrollbar-none py-0.5 flex-1"
          >
            {coreTabs.slice(0, MAX_VISIBLE_TABS).map((filter) => {
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
          </div>

          {/* Explorar catálogo — siempre al final */}
          {exploreTab && (
            <button
              type="button"
              onClick={() => onSelectCategory(exploreTab.id)}
              className={`relative px-3 py-1.5 rounded-full text-xs font-medium select-none transition-colors duration-150 shrink-0 ${
                activeFilter === 'explore'
                  ? 'text-black font-semibold'
                  : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
              }`}
            >
              {activeFilter === 'explore' && (
                <motion.div
                  layoutId="unifiedActiveFilterPill"
                  className="absolute inset-0 rounded-full bg-amber-400 shadow-sm"
                  transition={{ type: 'spring', bounce: 0.15, duration: 0.35 }}
                />
              )}
              <span className="relative z-10">{exploreTab.label}</span>
            </button>
          )}
        </div>
      </div>
    </header>
  );
};
