import { describe, expect, it } from 'vitest';
import { getCastActionNotice } from './castRequestNotice';

describe('Chromecast request feedback', () => {
  it('does not show an error before a request fails or while the cast session is active', () => {
    expect(getCastActionNotice(false, 'idle', null)).toBeNull();
    expect(getCastActionNotice(true, 'error', 'Rejected')).toBeNull();
  });

  it('shows progress while looking for a Cast device', () => {
    expect(getCastActionNotice(false, 'loading', null)).toBe('Buscando dispositivos Google Cast…');
  });

  it('surfaces the reason when no Cast session was established', () => {
    expect(getCastActionNotice(false, 'error', 'Google Cast no está disponible.'))
      .toBe('Google Cast no está disponible.');
  });

  it('uses a clear fallback when a failed request has no message', () => {
    expect(getCastActionNotice(false, 'error', null))
      .toBe('No se pudo abrir el selector de dispositivos.');
  });
});
