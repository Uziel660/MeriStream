import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';

const STORAGE_KEY = 'meristream_hidden_genres_v1';
const CHANGE_EVENT = 'meristream:hidden-genres-changed';
const PROVIDER_EVENT_SOURCE = 'hidden-genres-provider';

interface HiddenGenresCtx {
  hiddenGenres: Set<string>;
  isGenreHidden: (genre: string) => boolean;
  toggleGenre: (genre: string) => void;
  hideGenre: (genre: string) => void;
  showGenre: (genre: string) => void;
  hiddenCount: number;
}

const HiddenGenresContext = createContext<HiddenGenresCtx | null>(null);

function readStorage(): Set<string> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        return new Set(parsed.map((genre) => String(genre).trim().toLowerCase()).filter(Boolean));
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

export function HiddenGenresProvider({ children }: { children: React.ReactNode }) {
  const [hiddenGenres, setHiddenGenres] = useState<Set<string>>(readStorage);

  const syncFromStorage = useCallback(() => {
    const next = readStorage();
    setHiddenGenres((current) => (sameGenres(current, next) ? current : next));
  }, []);

  // Sincronizar cambios hechos fuera de este Provider y entre pestañas.
  useEffect(() => {
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
  }, [syncFromStorage]);

  const persist = useCallback((next: Set<string>) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
    } catch {}

    // Una sola actualización React. Antes persist() volvía a llamar al setter
    // desde dentro del updater del mismo estado, generando actualizaciones reentrantes.
    setHiddenGenres(next);
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, {
      detail: { source: PROVIDER_EVENT_SOURCE },
    }));
  }, []);

  const isGenreHidden = useCallback(
    (genre: string) => hiddenGenres.has(String(genre || '').trim().toLowerCase()),
    [hiddenGenres]
  );

  const hideGenre = useCallback((genre: string) => {
    const key = String(genre || '').trim().toLowerCase();
    if (!key || hiddenGenres.has(key)) return;
    const next = new Set(hiddenGenres);
    next.add(key);
    persist(next);
  }, [hiddenGenres, persist]);

  const showGenre = useCallback((genre: string) => {
    const key = String(genre || '').trim().toLowerCase();
    if (!key || !hiddenGenres.has(key)) return;
    const next = new Set(hiddenGenres);
    next.delete(key);
    persist(next);
  }, [hiddenGenres, persist]);

  const toggleGenre = useCallback((genre: string) => {
    const key = String(genre || '').trim().toLowerCase();
    if (!key) return;
    const next = new Set(hiddenGenres);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    persist(next);
  }, [hiddenGenres, persist]);

  return (
    <HiddenGenresContext.Provider
      value={{ hiddenGenres, isGenreHidden, hideGenre, showGenre, toggleGenre, hiddenCount: hiddenGenres.size }}
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
      isGenreHidden: () => false,
      toggleGenre: () => {},
      hideGenre: () => {},
      showGenre: () => {},
      hiddenCount: 0,
    };
  }
  return ctx;
}
