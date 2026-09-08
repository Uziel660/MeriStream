import React, { useState, useEffect, useRef } from 'react';
import { Search, X, Play, LogOut, LogIn, ChevronDown, ArrowLeft, SlidersHorizontal } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { PreferencesPanel } from './PreferencesPanel';

export interface FilterItem {
  id: string;
  label: string;
}

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

const MAX_VISIBLE_TABS = 7;
const AVATAR_BG_MAP: Record<string, string> = {
  amber: 'bg-[#f59e0b] text-black', emerald: 'bg-emerald-500 text-black', crimson: 'bg-red-600 text-white',
  indigo: 'bg-indigo-600 text-white', rose: 'bg-pink-600 text-white', cyan: 'bg-cyan-500 text-black',
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
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [atTop, setAtTop] = useState(true);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const accountTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileSearchTriggerRef = useRef<HTMLButtonElement>(null);
  const searchContainerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (searchQuery !== undefined) setQuery(searchQuery); }, [searchQuery]);
  useEffect(() => { const timer = setTimeout(() => onSearchChange(query), 200); return () => clearTimeout(timer); }, [query, onSearchChange]);
  useEffect(() => {
    const onScroll = () => setAtTop(window.scrollY < 18);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) setIsUserMenuOpen(false);
      if (mobileSearchOpen && searchContainerRef.current && !searchContainerRef.current.contains(e.target as Node) && !mobileSearchTriggerRef.current?.contains(e.target as Node)) {
        setMobileSearchOpen(false);
      }
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [mobileSearchOpen]);
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (mobileSearchOpen) {
        e.preventDefault();
        setMobileSearchOpen(false);
        requestAnimationFrame(() => mobileSearchTriggerRef.current?.focus());
        return;
      }
      if (isUserMenuOpen) {
        e.preventDefault();
        setIsUserMenuOpen(false);
        requestAnimationFrame(() => accountTriggerRef.current?.focus());
      }
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [mobileSearchOpen, isUserMenuOpen]);
  useEffect(() => {
    if (mobileSearchOpen) requestAnimationFrame(() => searchInputRef.current?.focus());
  }, [mobileSearchOpen]);

  const closeMobileSearch = (restoreFocus = true) => {
    setMobileSearchOpen(false);
    if (restoreFocus) requestAnimationFrame(() => mobileSearchTriggerRef.current?.focus());
  };
  const openMobileSearch = () => {
    setIsUserMenuOpen(false);
    setMobileSearchOpen(true);
  };
  const handleSelectTab = (id: string) => {
    setQuery('');
    setMobileSearchOpen(false);
    setIsUserMenuOpen(false);
    onSearchChange('');
    onSelectCategory(id);
  };
  const avatarBg = user?.avatar && AVATAR_BG_MAP[user.avatar] ? AVATAR_BG_MAP[user.avatar] : AVATAR_BG_MAP.amber;
  const coreTabs = MAIN_QUICK_FILTERS.slice(0, 4);
  const quickGenres = MAIN_QUICK_FILTERS.slice(4, MAX_VISIBLE_TABS);
  const exploreTab = MAIN_QUICK_FILTERS.find(f => f.id === 'explore')!;

  return (
    <header id="main-unified-header" className={`site-header ${atTop ? 'is-at-top' : ''} ${mobileSearchOpen ? 'has-search-open' : ''}`}>
      <div className="header-inner">
        <div className="header-top">
          <a href="/" onClick={e => { e.preventDefault(); handleSelectTab('all'); }} className="brand" aria-label="MeriStream, inicio">
            <span className="brand-symbol" aria-hidden="true"><Play size={18} fill="currentColor" /></span>
            <span>meri<span className="brand-light">stream</span><span className="brand-period">.</span></span>
          </a>

          <div ref={searchContainerRef} id="catalog-search" className={`header-search ${mobileSearchOpen ? 'is-mobile-open' : ''}`} role="search">
            <Search size={18} aria-hidden="true" />
            <input ref={searchInputRef} type="search" value={query} onChange={e => setQuery(e.target.value)} aria-label="Buscar en el catálogo" placeholder="Buscar películas, series o anime" />
            {query && <button type="button" className="search-clear" onClick={() => setQuery('')} aria-label="Limpiar búsqueda"><X size={17} /></button>}
            <button type="button" className="search-clear sm:hidden" onClick={() => closeMobileSearch()} aria-label="Cerrar búsqueda"><ArrowLeft size={17} /></button>
          </div>

          <div className="flex items-center justify-end gap-1">
            <button
              ref={mobileSearchTriggerRef}
              type="button"
              className="mobile-search-trigger search-toggle ui-icon-button"
              onClick={() => mobileSearchOpen ? closeMobileSearch(false) : openMobileSearch()}
              aria-label={mobileSearchOpen ? 'Cerrar búsqueda' : 'Abrir búsqueda'}
              aria-expanded={mobileSearchOpen}
              aria-controls="catalog-search"
            >
              <Search size={18} />
            </button>
            <div className="header-account" ref={userMenuRef}>
              {isAuthenticated && user ? (
                <>
                  <button
                    ref={accountTriggerRef}
                    type="button"
                    className="account-trigger"
                    onClick={() => {
                      const willOpen = !isUserMenuOpen;
                      if (willOpen) setMobileSearchOpen(false);
                      setIsUserMenuOpen(willOpen);
                    }}
                    aria-label={isUserMenuOpen ? 'Cerrar mi cuenta' : 'Abrir mi cuenta'}
                    aria-expanded={isUserMenuOpen}
                    aria-controls="account-menu"
                  >
                    <span className={`account-avatar ${avatarBg}`}>{user.username.charAt(0).toUpperCase()}</span>
                    <span className="account-name">{user.username}</span><ChevronDown size={15} />
                  </button>
                  {isUserMenuOpen && (
                      <div id="account-menu" className="account-menu">
                      <strong>{user.username}</strong><p>Tu cuenta MeriStream</p>
                      <button type="button" className="flex w-full items-center gap-2 rounded-lg border border-zinc-700/70 bg-zinc-900/70 px-3 py-2 text-left text-xs text-zinc-200 transition hover:border-amber-400/50 hover:bg-zinc-800" onClick={() => { setPreferencesOpen(true); setIsUserMenuOpen(false); }}>
                        <SlidersHorizontal size={15} className="text-amber-400" />Preferencias de reproducción
                      </button>
                      <span className="account-color-label">Color de perfil</span>
                      <div className="account-colors">{Object.keys(AVATAR_BG_MAP).map(colorKey => (
                        <button key={colorKey} type="button" onClick={() => updateAvatar(colorKey)} aria-label={`Color de perfil: ${colorKey}`} aria-pressed={user.avatar === colorKey} className="avatar-choice"><span className={AVATAR_BG_MAP[colorKey].split(' ')[0]} /></button>
                      ))}</div>
                      <button type="button" className="logout-button" onClick={() => { logout(); setIsUserMenuOpen(false); }}><LogOut size={16} />Cerrar sesión</button>
                    </div>
                  )}
                </>
              ) : (
                <button type="button" onClick={() => { setMobileSearchOpen(false); openAuthModal(); }} className="account-login"><LogIn size={17} /><span>Ingresar</span></button>
              )}
            </div>
          </div>
        </div>

        <div className="header-bottom">
          <nav className="primary-nav" aria-label="Navegación principal">
            {[...coreTabs, exploreTab].map(filter => (
              <button type="button" key={filter.id} onClick={() => handleSelectTab(filter.id)} aria-current={activeFilter === filter.id ? 'page' : undefined} className={activeFilter === filter.id ? 'nav-item is-active' : 'nav-item'}>
                {filter.id === 'explore' ? 'Explorar' : filter.label}
              </button>
            ))}
          </nav>
          <nav className="genre-nav" aria-label="Géneros rápidos"><span>Géneros</span>{quickGenres.map(filter => (
            <button type="button" key={filter.id} onClick={() => handleSelectTab(filter.id)} aria-pressed={activeFilter.toLowerCase() === filter.id.toLowerCase()} className="genre-shortcut">{filter.label}</button>
          ))}</nav>
        </div>
      </div>
      {preferencesOpen && <PreferencesPanel userId={user?.id} onClose={() => setPreferencesOpen(false)} />}
    </header>
  );
};
