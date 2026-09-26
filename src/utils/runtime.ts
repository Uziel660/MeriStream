// src/utils/runtime.ts
// Browser/native runtime bridge. Android ships only the frontend; API,
// playback proxy, subtitles and Watch Party remain on the MeriStream server.

const configuredOrigin = String(import.meta.env.VITE_API_ORIGIN || '').trim().replace(/\/$/, '');

export function isNativeShell(): boolean {
  return typeof window !== 'undefined'
    && Boolean((window as any).Capacitor?.isNativePlatform?.());
}

/**
 * Marks the Capacitor build before React renders so presentation CSS can use a
 * native-only surface without forking the web application. This keeps Android
 * updateable from the same React tree while allowing true mobile chrome.
 */
export function initializeNativePresentation(): void {
  if (!isNativeShell() || typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.nativeShell = 'android';
  root.classList.add('native-shell', 'native-shell-android');
}

/**
 * Tiny best-effort tactile acknowledgement for high-value mobile actions.
 * navigator.vibrate is intentionally used instead of a hard plugin dependency
 * so the shared web build stays untouched. Unsupported devices simply ignore it.
 */
export function nativeHaptic(pattern: number | number[] = 6): void {
  if (!isNativeShell() || typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  try { navigator.vibrate(pattern); } catch {}
}

export function isNativeLowCostPresentation(): boolean {
  if (!isNativeShell() || typeof document === 'undefined') return false;
  return document.documentElement.dataset.msPerformance !== 'quality';
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


let nativeFetchBridgeInstalled = false;

function rewriteNativeApiUrl(raw: string): string {
  if (!isNativeShell()) return raw;
  try {
    if (raw.startsWith('/api/')) return backendUrl(raw);
    const parsed = new URL(raw, window.location.href);
    if (parsed.origin === window.location.origin && parsed.pathname.startsWith('/api/')) {
      return backendUrl(`${parsed.pathname}${parsed.search}${parsed.hash}`);
    }
  } catch {
    // Keep the original value if it is not a valid URL.
  }
  return raw;
}

/**
 * Some legacy UI code still calls fetch('/api/...') directly. In the native
 * shell that path would otherwise point at the bundled WebView origin instead
 * of the MeriStream server. CapacitorHttp handles transport; this bridge only
 * rewrites same-origin API paths to the remote backend.
 */
export function installNativeFetchBridge(): void {
  if (!isNativeShell() || nativeFetchBridgeInstalled || typeof window.fetch !== 'function') return;
  nativeFetchBridgeInstalled = true;
  const originalFetch = window.fetch.bind(window);

  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string') return originalFetch(rewriteNativeApiUrl(input), init);
    if (input instanceof URL) return originalFetch(rewriteNativeApiUrl(input.toString()), init);
    return originalFetch(input, init);
  }) as typeof window.fetch;
}
