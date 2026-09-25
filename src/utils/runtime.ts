// src/utils/runtime.ts
// Browser/native runtime bridge. Android ships only the frontend; API,
// playback proxy, subtitles and Watch Party remain on the MeriStream server.

const configuredOrigin = String(import.meta.env.VITE_API_ORIGIN || '').trim().replace(/\/$/, '');

export function isNativeShell(): boolean {
  return typeof window !== 'undefined'
    && Boolean((window as any).Capacitor?.isNativePlatform?.());
}

export function backendBaseOrigin(): string {
  if (configuredOrigin) return configuredOrigin;
  if (isNativeShell()) return 'https://stream.merith.me';
  return '';
}

export function backendUrl(pathOrUrl: string): string {
  const value = String(pathOrUrl || '').trim();
  if (!value) return value;
  if (/^https?:\/\//i.test(value)) return value;
  const origin = backendBaseOrigin();
  if (!origin) return value;
  return `${origin}${value.startsWith('/') ? value : `/${value}`}`;
}

export function backendWsUrl(path = '/ws/watch-party'): string {
  const httpOrigin = backendBaseOrigin()
    || (typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:3010');
  const parsed = new URL(httpOrigin);
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  parsed.pathname = path;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}
