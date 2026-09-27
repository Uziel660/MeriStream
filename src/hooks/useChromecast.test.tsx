/**
 * @vitest-environment jsdom
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/runtime', () => ({ isNativeShell: () => true }));

import { useChromecast } from './useChromecast';

afterEach(() => {
  cleanup();
  document.querySelectorAll('script[data-meristream-cast-sdk="true"]').forEach((script) => script.remove());
  delete window.__onGCastApiAvailable;
  delete window.cast;
  delete window.chrome;
  delete (window as Window & { __gcast_initialized?: boolean }).__gcast_initialized;
});

describe('useChromecast unavailable device handling', () => {
  it('records an explicit error when the native shell cannot load Google Cast', async () => {
    const { result } = renderHook(() => useChromecast());

    await act(async () => {
      const request = result.current.requestCastSession();
      window.__onGCastApiAvailable?.(false);
      await request;
    });

    expect(result.current.remoteLoadState).toBe('error');
    expect(result.current.remoteLoadError).toBe('Google Cast no está disponible en este dispositivo.');
    expect(result.current.isCasting).toBe(false);
  });

  it('returns to idle when the user cancels the native device picker', async () => {
    const context = {
      requestSession: vi.fn().mockRejectedValue('cancel'),
      getCurrentSession: vi.fn(() => null),
    };
    (window as Window & { __gcast_initialized?: boolean }).__gcast_initialized = true;
    window.cast = { framework: { CastContext: { getInstance: () => context } } };
    window.chrome = { cast: {} };
    const { result } = renderHook(() => useChromecast());

    await act(async () => {
      await result.current.requestCastSession();
    });

    expect(context.requestSession).toHaveBeenCalledOnce();
    expect(result.current.remoteLoadState).toBe('idle');
    expect(result.current.remoteLoadError).toBeNull();
  });
});
