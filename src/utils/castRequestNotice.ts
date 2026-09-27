export type CastRequestState = 'idle' | 'loading' | 'playing' | 'error';

export function getCastActionNotice(
  isCasting: boolean,
  state: CastRequestState,
  error: string | null,
): string | null {
  if (isCasting || state === 'idle' || state === 'playing') return null;
  if (state === 'loading') return 'Buscando dispositivos Google Cast…';
  return error || 'No se pudo abrir el selector de dispositivos.';
}
