/**
 * @vitest-environment jsdom
 */
import { renderHook, act } from '@testing-library/react';
import { HiddenGenresProvider, useHiddenGenres } from './useHiddenGenres';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('useHiddenGenres', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <HiddenGenresProvider>{children}</HiddenGenresProvider>
  );

  describe('readStorage', () => {
    it('should load initial state from localStorage', () => {
      localStorage.setItem('meristream_hidden_genres_v1', JSON.stringify(['Action', 'Comedy']));
      const { result } = renderHook(() => useHiddenGenres(), { wrapper });
      expect(result.current.hiddenGenres.size).toBe(2);
      expect(result.current.hiddenGenres.has('action')).toBe(true);
      expect(result.current.hiddenGenres.has('comedy')).toBe(true);
    });

    it('should handle malformed JSON in localStorage without throwing', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockReturnValue('invalid-json');
      const { result } = renderHook(() => useHiddenGenres(), { wrapper });
      expect(result.current.hiddenGenres.size).toBe(0);
    });

    it('should handle localStorage throwing an error', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('localStorage is disabled');
      });
      const { result } = renderHook(() => useHiddenGenres(), { wrapper });
      expect(result.current.hiddenGenres.size).toBe(0);
    });
  });

  describe('mutations', () => {
    it('should hide a genre and persist to localStorage', () => {
      const { result } = renderHook(() => useHiddenGenres(), { wrapper });

      act(() => {
        result.current.hideGenre('Drama');
      });

      expect(result.current.isGenreHidden('drama')).toBe(true);
      expect(result.current.hiddenCount).toBe(1);

      const stored = JSON.parse(localStorage.getItem('meristream_hidden_genres_v1') || '[]');
      expect(stored).toContain('drama');
    });

    it('should show a previously hidden genre', () => {
      localStorage.setItem('meristream_hidden_genres_v1', JSON.stringify(['drama']));
      const { result } = renderHook(() => useHiddenGenres(), { wrapper });

      act(() => {
        result.current.showGenre('Drama');
      });

      expect(result.current.isGenreHidden('drama')).toBe(false);
      expect(result.current.hiddenCount).toBe(0);

      const stored = JSON.parse(localStorage.getItem('meristream_hidden_genres_v1') || '[]');
      expect(stored).not.toContain('drama');
    });

    it('should toggle a genre', () => {
      const { result } = renderHook(() => useHiddenGenres(), { wrapper });

      act(() => {
        result.current.toggleGenre('Drama');
      });
      expect(result.current.isGenreHidden('drama')).toBe(true);

      act(() => {
        result.current.toggleGenre('Drama');
      });
      expect(result.current.isGenreHidden('drama')).toBe(false);
    });

    it('should handle localStorage.setItem throwing an error', () => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('Quota exceeded');
      });

      const { result } = renderHook(() => useHiddenGenres(), { wrapper });

      act(() => {
        result.current.hideGenre('Drama');
      });

      // Should still update React state even if persistence fails
      expect(result.current.isGenreHidden('drama')).toBe(true);
    });
  });

  describe('events', () => {
    it('should sync when CHANGE_EVENT is dispatched', () => {
      const { result } = renderHook(() => useHiddenGenres(), { wrapper });

      act(() => {
        localStorage.setItem('meristream_hidden_genres_v1', JSON.stringify(['action']));
        window.dispatchEvent(new Event('meristream:hidden-genres-changed'));
      });

      expect(result.current.isGenreHidden('action')).toBe(true);
    });

    it('should sync when storage event is dispatched', () => {
      const { result } = renderHook(() => useHiddenGenres(), { wrapper });

      act(() => {
        localStorage.setItem('meristream_hidden_genres_v1', JSON.stringify(['action']));
        window.dispatchEvent(new StorageEvent('storage', { key: 'meristream_hidden_genres_v1' }));
      });

      expect(result.current.isGenreHidden('action')).toBe(true);
    });
  });

  describe('fallback', () => {
    it('should return fallback when used outside provider', () => {
      // Suppress React warning about missing context
      const originalError = console.error;
      console.error = vi.fn();

      const { result } = renderHook(() => useHiddenGenres());

      expect(result.current.hiddenGenres.size).toBe(0);
      expect(result.current.isGenreHidden('action')).toBe(false);

      // These shouldn't crash
      act(() => {
        result.current.hideGenre('action');
        result.current.showGenre('action');
        result.current.toggleGenre('action');
      });

      console.error = originalError;
    });
  });
});
