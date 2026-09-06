import React, { useState, useEffect, useRef } from 'react';
import { Search, X, Play, LogOut, LogIn, ChevronDown } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useAuth } from '../contexts/AuthContext';

export interface FilterItem {
  id: string;
  label: string;
}

/** Pestañas fijas: las primeras son categorías principales, el resto géneros rápidos. */
export const MAIN_QUICK_FILTERS: FilterItem[] = [
  { id: 'all', label: 'Inicio' },
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
  amber: 'bg-[#f59e0b] text-black',
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
  searchQuery?: string;
}

export const UnifiedHeader: React.FC<UnifiedHeaderProps> = ({ onSearchChange, activeFilter, onSelectCategory, searchQuery }) => {
  const { user, isAuthenticated, openAuthModal, logout, updateAvatar } = useAuth();
  const [query, setQuery] = useState(searchQuery || '');
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (searchQuery !== undefined) setQuery(searchQuery);
  }, [searchQuery]);
  useEffect(() => {
    const timer = setTimeout(() => onSearchChange(query), 200);
    return () => clearTimeout(timer);
  }, [query, onSearchChange]);
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) setIsUserMenuOpen(false);
    };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') setIsUserMenuOpen(false); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, []);

  const handleSelectTab = (id: string) => {
    setQuery('');
    onSearchChange('');
    onSelectCategory(id);
  };
  const avatarBg = user?.avatar && AVATAR_BG_MAP[user.avatar] ? AVATAR_BG_MAP[user.avatar] : AVATAR_BG_MAP.amber;
  const coreTabs = MAIN_QUICK_FILTERS.slice(0, 4);
  const quickGenres = MAIN_QUICK_FILTERS.slice(4, MAX_VISIBLE_TABS);
  const exploreTab = MAIN_QUICK_FILTERS.find(f => f.id === 'explore')!;

  return (
    <header id="main-unified-header" className="site-header">
      <div className="header-inner">
        <div className="header-top">
          <a href="/" onClick={e => { e.preventDefault(); onSelectCategory('all'); }} className="brand" aria-label="MeriStream, inicio">
            <span className="brand-symbol" aria-hidden="true"><Play size={19} fill="currentColor" /></span>
            <span>meri<span className="brand-light">stream</span><span className="brand-period">.</span></span>
          </a>
          <div className="header-search" role="search">
            <Search size={18} aria-hidden="true" />
            <input type="search" value={query} onChange={e => setQuery(e.target.value)}
              aria-label="Buscar en el catálogo" placeholder="Busca tu próxima historia" />
            {query && <button type="button" className="search-clear" onClick={() => setQuery('')} aria-label="Limpiar búsqueda"><X size={17} /></button>}
          </div>
          <div className="header-account" ref={userMenuRef}>
            {isAuthenticated && user ? (
              <>
                <button type="button" className="account-trigger" onClick={() => setIsUserMenuOpen(!isUserMenuOpen)} aria-label="Abrir mi cuenta" aria-expanded={isUserMenuOpen}>
                  <span className={`account-avatar ${avatarBg}`}>{user.username.charAt(0).toUpperCase()}</span>
                  <span className="account-name">{user.username}</span><ChevronDown size={15} />
                </button>
                <AnimatePresence>{isUserMenuOpen && (
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="account-menu">
                    <strong>{user.username}</strong><p>Tu cuenta MeriStream</p>
                    <span className="account-color-label">Color de perfil</span>
                    <div className="account-colors">{Object.keys(AVATAR_BG_MAP).map(colorKey => (
                      <button key={colorKey} type="button" onClick={() => updateAvatar(colorKey)} aria-label={`Color de perfil: ${colorKey}`} aria-pressed={user.avatar === colorKey} className="avatar-choice">
                        <span className={AVATAR_BG_MAP[colorKey].split(' ')[0]} />
                      </button>
                    ))}</div>
                    <button type="button" className="logout-button" onClick={() => { logout(); setIsUserMenuOpen(false); }}><LogOut size={16} />Cerrar sesión</button>
                  </motion.div>
                )}</AnimatePresence>
              </>
            ) : (
              <button type="button" onClick={openAuthModal} className="account-login"><LogIn size={17} /><span>Ingresar</span></button>
            )}
          </div>
        </div>
        <div className="header-bottom">
          <nav className="primary-nav" aria-label="Navegación principal">
            {[...coreTabs, exploreTab].map(filter => (
              <button type="button" key={filter.id} onClick={() => handleSelectTab(filter.id)}
                aria-current={activeFilter === filter.id ? 'page' : undefined}
                className={activeFilter === filter.id ? 'nav-item is-active' : 'nav-item'}>
                {filter.id === 'explore' ? 'Explorar' : filter.label}
              </button>
            ))}
          </nav>
          <nav className="genre-nav" aria-label="Géneros rápidos"><span>Por género</span>{quickGenres.map(filter => (
            <button type="button" key={filter.id} onClick={() => handleSelectTab(filter.id)} aria-pressed={activeFilter.toLowerCase() === filter.id.toLowerCase()}
              className="genre-shortcut">{filter.label}</button>
          ))}</nav>
        </div>
      </div>
    </header>
  );
};
