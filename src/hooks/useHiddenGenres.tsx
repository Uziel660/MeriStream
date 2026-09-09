import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';

const STORAGE_KEY = 'meristream_hidden_genres_v1';
const SHOW_STORAGE_KEY = 'meristream_hidden_shows_v1';
const CHANGE_EVENT = 'meristream:hidden-genres-changed';
const PROVIDER_EVENT_SOURCE = 'hidden-genres-provider';

interface HiddenGenresCtx {
  hiddenGenres: Set<string>;
  hiddenShowIds: Set<string>;
  isGenreHidden: (genre: string) => boolean;
  isShowHidden: (show: unknown) => boolean;
  toggleGenre: (genre: string) => void;
  hideGenre: (genre: string) => void;
  showGenre: (genre: string) => void;
  toggleShow: (show: unknown) => void;
  hideShow: (show: unknown) => void;
  showShow: (show: unknown) => void;
  hiddenCount: number;
}

const HiddenGenresContext = createContext<HiddenGenresCtx | null>(null);

function normalizeKey(value: unknown): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function readStorage(key: string, normalize = false): Set<string> {
  try {
    const stored = localStorage.getItem(key);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        return new Set(parsed.map((value) => normalize ? normalizeKey(value) : String(value).trim()).filter(Boolean));
      }
    }
  } catch {}
  return new Set();
}

function sameGenres(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const genre of a) if (!b.has(genre)) return false;
  return true;
}

function showKeys(show: unknown): string[] {
  if (typeof show === 'string') return [show.trim()].filter(Boolean);
  const item = (show || {}) as any;
  const keys = [String(item.id || '').trim()].filter(Boolean);
  const tmdbId = Number(item.tmdb_id);
  if (Number.isInteger(tmdbId) && tmdbId > 0) {
    const rawKind = String(item.kind || item.category || 'series').toLowerCase();
    const kind = rawKind.includes('movie') || rawKind.includes('pel') ? 'movie' : rawKind.includes('anime') ? 'anime' : 'series';
    keys.push(`tmdb-${kind}-${tmdbId}`, `tmdb:${kind}:${tmdbId}`);
  }
  return keys;
}

function primaryShowKey(show: unknown): string | null {
  const keys = showKeys(show);
  return keys.find((key) => key.startsWith('tmdb:')) || keys[0] || null;
}

function visibleGenreKey(value: unknown): string {
  return normalizeKey(value);
}

export function HiddenGenresProvider({ children }: { children: React.ReactNode }) {
  const [hiddenGenres, setHiddenGenres] = useState<Set<string>>(() => readStorage(STORAGE_KEY, true));
  const [hiddenShowIds, setHiddenShowIds] = useState<Set<string>>(() => readStorage(SHOW_STORAGE_KEY));

  const syncFromServer = useCallback(async () => {
    try {
      const response = await fetch('/api/v1/catalog/visibility', { cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json();
      const serverGenres = new Set<string>((Array.isArray(data.hiddenGenres) ? data.hiddenGenres : []).map(visibleGenreKey).filter(Boolean));
      const serverShows = new Set<string>((Array.isArray(data.hiddenShowIds) ? data.hiddenShowIds : []).map((value: unknown) => String(value).trim()).filter(Boolean));
      // Conserva una configuración local anterior durante la migración al
      // servidor. El panel de administración la sincroniza al siguiente cambio.
      const mergedGenres = new Set<string>([...readStorage(STORAGE_KEY, true), ...serverGenres]);
      const mergedShows = new Set<string>([...readStorage(SHOW_STORAGE_KEY), ...serverShows]);
      setHiddenGenres((current) => sameGenres(current, mergedGenres) ? current : mergedGenres);
      setHiddenShowIds((current) => sameGenres(current, mergedShows) ? current : mergedShows);
    } catch {
      // El catálogo público sigue funcionando con el último estado local.
    }
  }, []);

  const syncFromStorage = useCallback(() => {
    const next = readStorage(STORAGE_KEY, true);
    const nextShows = readStorage(SHOW_STORAGE_KEY);
    setHiddenGenres((current) => (sameGenres(current, next) ? current : next));
    setHiddenShowIds((current) => (sameGenres(current, nextShows) ? current : nextShows));
  }, []);

  // Sincronizar cambios hechos fuera de este Provider y entre pestañas.
  useEffect(() => {
    void syncFromServer();
    const onCustomChange = (event: Event) => {
      if (event instanceof CustomEvent && event.detail?.source === PROVIDER_EVENT_SOURCE) return;
      syncFromStorage();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === null) syncFromStorage();
    };

    window.addEventListener(CHANGE_EVENT, onCustomChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(CHANGE_EVENT, onCustomChange);
      window.removeEventListener('storage', onStorage);
    };
  }, [syncFromStorage, syncFromServer]);

  const persist = useCallback((next: Set<string>, nextShows: Set<string>) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
      localStorage.setItem(SHOW_STORAGE_KEY, JSON.stringify([...nextShows]));
    } catch {}

    // Una sola actualización React. Antes persist() volvía a llamar al setter
    // desde dentro del updater del mismo estado, generando actualizaciones reentrantes.
    setHiddenGenres(next);
    setHiddenShowIds(nextShows);
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, {
      detail: { source: PROVIDER_EVENT_SOURCE },
    }));
    void fetch('/api/v1/admin/catalog/visibility', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hiddenGenres: [...next], hiddenShowIds: [...nextShows] }),
    }).catch(() => undefined);
  }, []);

  const isGenreHidden = useCallback(
    (genre: string) => hiddenGenres.has(visibleGenreKey(genre)),
    [hiddenGenres]
  );

  const isShowHidden = useCallback((show: unknown) => showKeys(show).some((key) => hiddenShowIds.has(key)), [hiddenShowIds]);

  const hideGenre = useCallback((genre: string) => {
    const key = visibleGenreKey(genre);
    if (!key || hiddenGenres.has(key)) return;
    const next = new Set(hiddenGenres);
    next.add(key);
    persist(next, hiddenShowIds);
  }, [hiddenGenres, hiddenShowIds, persist]);

  const showGenre = useCallback((genre: string) => {
    const key = visibleGenreKey(genre);
    if (!key || !hiddenGenres.has(key)) return;
    const next = new Set(hiddenGenres);
    next.delete(key);
    persist(next, hiddenShowIds);
  }, [hiddenGenres, hiddenShowIds, persist]);

  const toggleGenre = useCallback((genre: string) => {
    const key = visibleGenreKey(genre);
    if (!key) return;
    const next = new Set(hiddenGenres);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    persist(next, hiddenShowIds);
  }, [hiddenGenres, hiddenShowIds, persist]);

  const toggleShow = useCallback((show: unknown) => {
    const key = primaryShowKey(show);
    if (!key) return;
    const next = new Set(hiddenShowIds);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    persist(hiddenGenres, next);
  }, [hiddenGenres, hiddenShowIds, persist]);

  const hideShow = useCallback((show: unknown) => {
    const next = new Set(hiddenShowIds);
    const key = primaryShowKey(show);
    if (key) next.add(key);
    persist(hiddenGenres, next);
  }, [hiddenGenres, hiddenShowIds, persist]);

  const showShow = useCallback((show: unknown) => {
    const next = new Set(hiddenShowIds);
    const key = primaryShowKey(show);
    if (key) next.delete(key);
    persist(hiddenGenres, next);
  }, [hiddenGenres, hiddenShowIds, persist]);

  return (
    <HiddenGenresContext.Provider
      value={{ hiddenGenres, hiddenShowIds, isGenreHidden, isShowHidden, hideGenre, showGenre, toggleGenre, toggleShow, hideShow, showShow, hiddenCount: hiddenGenres.size }}
    >
      {children}
    </HiddenGenresContext.Provider>
  );
}

export function useHiddenGenres(): HiddenGenresCtx {
  const ctx = useContext(HiddenGenresContext);
  if (!ctx) {
    // Fallback por si se usa fuera del Provider (no debería).
    return {
      hiddenGenres: new Set(),
      hiddenShowIds: new Set(),
      isGenreHidden: () => false,
      isShowHidden: () => false,
      toggleGenre: () => {},
      hideGenre: () => {},
      showGenre: () => {},
      toggleShow: () => {},
      hideShow: () => {},
      showShow: () => {},
      hiddenCount: 0,
    };
  }
  return ctx;
}
