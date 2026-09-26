import React, { useState, useEffect, useRef } from 'react';
import { Search, X, Play, LogOut, LogIn, ChevronDown, ArrowLeft, ArrowUp, SlidersHorizontal, Bookmark, Users, Menu } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { PreferencesPanel } from './PreferencesPanel';
import { APP_PREFERENCES_EVENT, applyAppPreferencesToDocument } from '../utils/appPreferences';
import { useHiddenGenres } from '../hooks/useHiddenGenres';
import { isNativeShell, nativeHaptic } from '../utils/runtime';

export interface FilterItem {
  id: string;
  label: string;
}

export const MAIN_QUICK_FILTERS: FilterItem[] = [
  { id: 'all', label: 'Inicio' },
  { id: 'anime', label: 'Anime' },
  { id: 'movie', label: 'Películas' },
  { id: 'series', label: 'Series' },
  { id: 'my-lists', label: 'Mis Listas' },
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
  onOpenWatchParty?: () => void;
}

export const UnifiedHeader: React.FC<UnifiedHeaderProps> = ({ onSearchChange, activeFilter, onSelectCategory, searchQuery, onOpenWatchParty }) => {

  const { user, isAuthenticated, openAuthModal, logout, updateAvatar } = useAuth();
  const { isGenreHidden } = useHiddenGenres();
  const [query, setQuery] = useState(searchQuery || '');
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [atTop, setAtTop] = useState(true);
  const [mobileChromeHidden, setMobileChromeHidden] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const accountTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileSearchTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileNavTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileNavSheetRef = useRef<HTMLDivElement>(null);
  const preferencesTriggerRef = useRef<HTMLButtonElement>(null);
  const searchContainerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (searchQuery !== undefined) setQuery(searchQuery); }, [searchQuery]);
  useEffect(() => { const timer = setTimeout(() => onSearchChange(query), 200); return () => clearTimeout(timer); }, [query, onSearchChange]);
  useEffect(() => {
    const native = isNativeShell();
    let lastY = window.scrollY;
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const y = Math.max(0, window.scrollY);
        setAtTop(y < 18);
        if (native) {
          if (y < 36) setMobileChromeHidden(false);
          else if (y > lastY + 7) setMobileChromeHidden(true);
          else if (y < lastY - 7) setMobileChromeHidden(false);
        }
        lastY = y;
        ticking = false;
      });
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (mobileSearchOpen || mobileNavOpen || isUserMenuOpen || preferencesOpen) {
      setMobileChromeHidden(false);
    }
  }, [mobileSearchOpen, mobileNavOpen, isUserMenuOpen, preferencesOpen]);

  // Preferencias soporta también el perfil invitado. Aplicarlas desde el
  // header evita que una capacidad existente quede escondida detrás del login
  // y mantiene sincronizado el modo de rendimiento al cambiar de perfil.
  useEffect(() => {
    const applyPreferences = () => { applyAppPreferencesToDocument(user?.id); };
    applyPreferences();
    window.addEventListener(APP_PREFERENCES_EVENT, applyPreferences);
    return () => window.removeEventListener(APP_PREFERENCES_EVENT, applyPreferences);
  }, [user?.id]);

  useEffect(() => {
    const outside = (e: PointerEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) setIsUserMenuOpen(false);
      if (mobileSearchOpen && searchContainerRef.current && !searchContainerRef.current.contains(e.target as Node) && !mobileSearchTriggerRef.current?.contains(e.target as Node)) {
        setMobileSearchOpen(false);
      }
      if (mobileNavOpen && mobileNavSheetRef.current && !mobileNavSheetRef.current.contains(e.target as Node) && !mobileNavTriggerRef.current?.contains(e.target as Node)) {
        setMobileNavOpen(false);
      }
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [mobileSearchOpen, mobileNavOpen]);
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (preferencesOpen) {
        e.preventDefault();
        setPreferencesOpen(false);
        requestAnimationFrame(() => preferencesTriggerRef.current?.focus());
        return;
      }
      if (mobileSearchOpen) {
        e.preventDefault();
        setMobileSearchOpen(false);
        requestAnimationFrame(() => mobileSearchTriggerRef.current?.focus());
        return;
      }
      if (mobileNavOpen) {
        e.preventDefault();
        setMobileNavOpen(false);
        requestAnimationFrame(() => mobileNavTriggerRef.current?.focus());
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
  }, [preferencesOpen, mobileSearchOpen, mobileNavOpen, isUserMenuOpen]);
  useEffect(() => {
    if (mobileSearchOpen) requestAnimationFrame(() => searchInputRef.current?.focus());
  }, [mobileSearchOpen]);

  const closeMobileSearch = (restoreFocus = true) => {
    setMobileSearchOpen(false);
    if (restoreFocus) requestAnimationFrame(() => mobileSearchTriggerRef.current?.focus());
  };
  const openMobileSearch = () => {
    nativeHaptic();
    setIsUserMenuOpen(false);
    setMobileNavOpen(false);
    setPreferencesOpen(false);
    setMobileSearchOpen(true);
  };
  const openPreferences = () => {
    setMobileSearchOpen(false);
    setMobileNavOpen(false);
    setIsUserMenuOpen(false);
    setPreferencesOpen(true);
  };
  const closePreferences = () => {
    setPreferencesOpen(false);
    requestAnimationFrame(() => preferencesTriggerRef.current?.focus());
  };
  const handleSelectTab = (id: string) => {
    nativeHaptic();
    setQuery('');
    setMobileSearchOpen(false);
    setMobileNavOpen(false);
    setIsUserMenuOpen(false);
    onSearchChange('');
    onSelectCategory(id);
  };
  const avatarBg = user?.avatar && AVATAR_BG_MAP[user.avatar] ? AVATAR_BG_MAP[user.avatar] : AVATAR_BG_MAP.amber;
  const coreTabs = MAIN_QUICK_FILTERS.slice(0, 5);
  const quickGenres = MAIN_QUICK_FILTERS.slice(5, MAX_VISIBLE_TABS + 1).filter((filter) => !isGenreHidden(filter.id));
  const exploreTab = MAIN_QUICK_FILTERS.find(f => f.id === 'explore')!;

  return (
    <header id="main-unified-header" className={`site-header ${atTop ? 'is-at-top' : ''} ${mobileSearchOpen ? 'has-search-open' : ''} ${mobileNavOpen ? 'has-mobile-nav-open' : ''} ${mobileChromeHidden ? 'is-chrome-hidden' : ''}`}>
      <div className="header-inner">
        <div className="header-top">
          <a href="/" onClick={e => { e.preventDefault(); handleSelectTab('all'); }} className="brand" aria-label="MeriStream, inicio">
            <span className="brand-symbol" aria-hidden="true"><Play size={18} fill="currentColor" /></span>
            <span>meri<span className="brand-light">stream</span><span className="brand-period">.</span></span>
          </a>

          <div ref={searchContainerRef} id="catalog-search" className={`header-search ${mobileSearchOpen ? 'is-mobile-open' : ''}`} role="search">
            <Search size={18} aria-hidden="true" />
            <input ref={searchInputRef} type="search" value={query} onChange={e => setQuery(e.target.value)} aria-label="Buscar en el catálogo" placeholder="Título, TMDB ID o IMDb ID" />
            {query && <button type="button" className="search-clear search-reset" onClick={() => setQuery('')} aria-label="Limpiar búsqueda"><X size={17} /></button>}
            <button type="button" className="search-clear search-close" onClick={() => closeMobileSearch()} aria-label="Cerrar búsqueda"><ArrowLeft size={17} /></button>
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

            <button
              ref={mobileNavTriggerRef}
              type="button"
              className="mobile-nav-trigger ui-icon-button hidden"
              onClick={() => {
                nativeHaptic();
                setMobileSearchOpen(false);
                setIsUserMenuOpen(false);
                setPreferencesOpen(false);
                setMobileNavOpen((open) => !open);
              }}
              aria-label={mobileNavOpen ? 'Cerrar navegación' : 'Abrir navegación'}
              aria-expanded={mobileNavOpen}
              aria-controls="mobile-nav-sheet"
            >
              <Menu size={19} />
            </button>

            <button
              type="button"
              className="header-watchparty-trigger ui-icon-button"
              onClick={onOpenWatchParty}
              aria-label="Watch Party - Ver en grupo"
              title="Watch Party (Ver en grupo)"
            >
              <Users size={18} className="text-amber-400 hover:text-amber-300 transition-colors" />
            </button>

            <button
              ref={preferencesTriggerRef}
              type="button"
              className="preferences-trigger ui-icon-button"
              onClick={openPreferences}
              aria-label="Abrir preferencias"
              aria-haspopup="dialog"
              aria-expanded={preferencesOpen}
              title="Preferencias"
            >
              <SlidersHorizontal size={18} />
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
                      if (willOpen) {
                        setMobileSearchOpen(false);
                        setPreferencesOpen(false);
                      }
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
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 rounded-lg border border-zinc-700/70 bg-zinc-900/70 px-3 py-2 text-left text-xs text-zinc-200 transition hover:border-amber-400/50 hover:bg-zinc-800"
                        onClick={() => handleSelectTab('my-lists')}
                      >
                        <Bookmark size={15} className="text-amber-400" />
                        <span>Mis Listas y Favoritos</span>
                      </button>
                      <button type="button" className="flex w-full items-center gap-2 rounded-lg border border-zinc-700/70 bg-zinc-900/70 px-3 py-2 text-left text-xs text-zinc-200 transition hover:border-amber-400/50 hover:bg-zinc-800" onClick={openPreferences}>
                        <SlidersHorizontal size={15} className="text-amber-400" />Preferencias
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
                <button type="button" aria-label="Ingresar" onClick={() => { setMobileSearchOpen(false); setPreferencesOpen(false); openAuthModal(); }} className="account-login"><LogIn size={17} /><span>Ingresar</span></button>
              )}
            </div>
          </div>
        </div>

        {mobileNavOpen && (
          <>
            <button
              type="button"
              className="mobile-nav-backdrop"
              aria-label="Cerrar navegación"
              onClick={() => { nativeHaptic(4); setMobileNavOpen(false); }}
            />
            <div ref={mobileNavSheetRef} id="mobile-nav-sheet" className="mobile-nav-sheet" role="dialog" aria-label="Navegación de MeriStream">
            <div className="mobile-nav-grid">
              {[...coreTabs, exploreTab].map((filter) => (
                <button
                  type="button"
                  key={filter.id}
                  onClick={() => handleSelectTab(filter.id)}
                  aria-current={activeFilter === filter.id ? 'page' : undefined}
                  className={activeFilter === filter.id ? 'mobile-nav-item is-active' : 'mobile-nav-item'}
                >
                  {filter.id === 'explore' ? 'Explorar' : filter.label}
                </button>
              ))}
            </div>
            <div className="mobile-nav-genres" aria-label="Géneros rápidos">
              {quickGenres.map((filter) => (
                <button
                  type="button"
                  key={filter.id}
                  onClick={() => handleSelectTab(filter.id)}
                  aria-pressed={activeFilter.toLowerCase() === filter.id.toLowerCase()}
                  className={activeFilter.toLowerCase() === filter.id.toLowerCase() ? 'mobile-nav-item is-active' : 'mobile-nav-item'}
                >
                  {filter.label}
                </button>
              ))}
            </div>
            <div className="mobile-nav-actions">
              <button
                type="button"
                className="mobile-nav-action"
                onClick={() => {
                  setMobileNavOpen(false);
                  onOpenWatchParty?.();
                }}
              >
                <Users size={16} />
                <span>Watch Party</span>
              </button>
              <button type="button" className="mobile-nav-action" onClick={openPreferences}>
                <SlidersHorizontal size={16} />
                <span>Preferencias</span>
              </button>
            </div>
            </div>
          </>
        )}

        <div className="header-bottom">
          <nav className="primary-nav" aria-label="Navegación principal">
            <button
              type="button"
              className="scroll-top-button"
              onClick={() => window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })}
              disabled={atTop}
              aria-label="Volver arriba"
              title="Volver arriba"
            >
              <ArrowUp size={15} aria-hidden="true" />
            </button>
            {[...coreTabs, exploreTab].map(filter => (
              <button type="button" key={filter.id} onClick={() => handleSelectTab(filter.id)} aria-current={activeFilter === filter.id ? 'page' : undefined} className={activeFilter === filter.id ? 'nav-item is-active' : 'nav-item'}>
                {filter.id === 'explore' ? 'Explorar' : filter.label}
              </button>
            ))}
          </nav>
          <nav className="genre-nav" aria-label="Géneros rápidos"><span className="genre-nav-label">Explorar por</span>{quickGenres.map(filter => (
            <button type="button" key={filter.id} onClick={() => handleSelectTab(filter.id)} aria-pressed={activeFilter.toLowerCase() === filter.id.toLowerCase()} className="genre-shortcut">{filter.label}</button>
          ))}</nav>
        </div>
      </div>
      {preferencesOpen && <PreferencesPanel userId={user?.id} canViewIdentityDetails={Boolean(user?.is_admin)} onClose={closePreferences} />}
    </header>
  );
};
