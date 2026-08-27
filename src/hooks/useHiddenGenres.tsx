import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';

const STORAGE_KEY = 'meristream_hidden_genres_v1';
const CHANGE_EVENT = 'meristream:hidden-genres-changed';

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
      const arr: string[] = JSON.parse(stored);
      return new Set(arr.map((g) => g.toLowerCase()));
    }
  } catch {}
  return new Set();
}

export function HiddenGenresProvider({ children }: { children: React.ReactNode }) {
  const [hiddenGenres, setHiddenGenres] = useState<Set<string>>(readStorage);

  // Escuchar cambios de otros componentes via custom event
  useEffect(() => {
    const handler = () => setHiddenGenres(readStorage());
    window.addEventListener(CHANGE_EVENT, handler);
    // También escuchar storage event (cross-tab)
    window.addEventListener('storage', handler);
    return () => {
      window.removeEventListener(CHANGE_EVENT, handler);
      window.removeEventListener('storage', handler);
    };
  }, []);

  const persist = useCallback((next: Set<string>) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
    } catch {}
    setHiddenGenres(next);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, []);

  const isGenreHidden = useCallback(
    (genre: string) => hiddenGenres.has(genre.toLowerCase()),
    [hiddenGenres]
  );

  const hideGenre = useCallback((genre: string) => {
    setHiddenGenres((prev) => {
      const next = new Set(prev);
      next.add(genre.toLowerCase());
      persist(next);
      return next;
    });
  }, [persist]);

  const showGenre = useCallback((genre: string) => {
    setHiddenGenres((prev) => {
      const next = new Set(prev);
      next.delete(genre.toLowerCase());
      persist(next);
      return next;
    });
  }, [persist]);

  const toggleGenre = useCallback((genre: string) => {
    setHiddenGenres((prev) => {
      const next = new Set(prev);
      const key = genre.toLowerCase();
      if (next.has(key)) next.delete(key);
      else next.add(key);
      persist(next);
      return next;
    });
  }, [persist]);

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
    // Fallback por si se usa fuera del Provider (no debería)
    const fallback: HiddenGenresCtx = {
      hiddenGenres: new Set(),
      isGenreHidden: () => false,
      toggleGenre: () => {},
      hideGenre: () => {},
      showGenre: () => {},
      hiddenCount: 0,
    };
    return fallback;
  }
  return ctx;
}
