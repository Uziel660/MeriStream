import {
  nativeAppBinding,
  nativeBindingsReady,
  nativeHapticsBinding,
  nativeScreenOrientationBinding,
  nativeShareBinding,
  nativeSystemBarsBinding,
} from './nativePluginBindings';

// src/utils/runtime.ts
// Browser/native runtime bridge. Android ships only the frontend; API,
// playback proxy, subtitles and Watch Party remain on the MeriStream server.

const configuredOrigin = String(import.meta.env.VITE_API_ORIGIN || '').trim().replace(/\/$/, '');

export function isNativeShell(): boolean {
  return typeof window !== 'undefined'
    && Boolean((window as any).Capacitor?.isNativePlatform?.());
}

function nativePlugin(name: string): any | null {
  if (!isNativeShell()) return null;
  const imported = name === 'App'
    ? nativeAppBinding
    : name === 'Haptics'
      ? nativeHapticsBinding
      : name === 'ScreenOrientation'
        ? nativeScreenOrientationBinding
        : name === 'SystemBars'
          ? nativeSystemBarsBinding
          : name === 'Share'
            ? nativeShareBinding
            : null;
  if (imported) return imported;

  // Fallback only for bridge-provided/built-in plugins. Official plugins use
  // generated module imports in the Android build.
  if (typeof window === 'undefined') return null;
  return (window as any).Capacitor?.Plugins?.[name] || null;
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
  root.dataset.nativeBindings = nativeBindingsReady ? 'ready' : 'fallback';
  const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const chromeMatch = userAgent.match(/(?:Chrome|CriOS)\/(\d+)/i);
  const webViewMajor = Number(chromeMatch && chromeMatch[1] ? chromeMatch[1] : 0);
  if (webViewMajor > 0) root.dataset.nativeWebviewMajor = String(webViewMajor);
  if (webViewMajor > 0 && webViewMajor < 84) root.dataset.nativeLegacyWebview = 'true';
  root.classList.add('native-shell', 'native-shell-android');
}

/**
 * Tiny best-effort tactile acknowledgement for high-value mobile actions.
 * navigator.vibrate is intentionally used instead of a hard plugin dependency
 * so the shared web build stays untouched. Unsupported devices simply ignore it.
 */
export function nativeHaptic(pattern: number | number[] = 6): void {
  if (!isNativeShell()) return;
  const haptics = nativePlugin('Haptics');
  if (haptics) {
    const duration = Array.isArray(pattern) ? Math.max(6, Number(pattern[0] || 6)) : Number(pattern || 6);
    const task = duration <= 20 && typeof haptics.impact === 'function'
      ? haptics.impact({ style: 'LIGHT' })
      : typeof haptics.vibrate === 'function'
        ? haptics.vibrate({ duration: Math.max(20, duration) })
        : null;
    if (task?.catch) task.catch(() => {});
    if (task) return;
  }
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    try { navigator.vibrate(pattern); } catch {}
  }
}

export async function nativeLockLandscape(): Promise<void> {
  if (!isNativeShell()) return;
  const plugin = nativePlugin('ScreenOrientation');
  if (typeof plugin?.lock === 'function') {
    try {
      await plugin.lock({ orientation: 'landscape' });
      return;
    } catch {}
  }
  try {
    const orientation = screen.orientation as ScreenOrientation & { lock?: (orientation: string) => Promise<void> };
    await orientation?.lock?.('landscape');
  } catch {}
}

export async function nativeUnlockOrientation(): Promise<void> {
  if (!isNativeShell()) return;
  const plugin = nativePlugin('ScreenOrientation');
  if (typeof plugin?.unlock === 'function') {
    try {
      await plugin.unlock();
      return;
    } catch {}
  }
  try {
    const orientation = screen.orientation as ScreenOrientation & { unlock?: () => void };
    orientation?.unlock?.();
  } catch {}
}

export async function nativeShare(options: { title?: string; text?: string; url?: string; dialogTitle?: string }): Promise<boolean> {
  if (isNativeShell()) {
    const share = nativePlugin('Share');
    if (typeof share?.share === 'function') {
      try {
        await share.share(options);
        nativeHaptic(4);
        return true;
      } catch {
        // The user cancelling the share sheet is not a playback/app failure.
      }
    }
  }

  if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: options.title, text: options.text, url: options.url });
      return true;
    } catch {}
  }
  return false;
}

export async function nativeSetImmersive(hidden: boolean): Promise<void> {
  if (!isNativeShell()) return;
  const systemBars = nativePlugin('SystemBars');
  try {
    if (hidden && typeof systemBars?.hide === 'function') {
      await systemBars.hide();
    } else if (!hidden && typeof systemBars?.show === 'function') {
      await systemBars.show();
      if (typeof systemBars?.setStyle === 'function') {
        await systemBars.setStyle({ style: 'DARK' });
      }
    }
  } catch {
    // CSS/Java system-bar fallbacks remain active when the plugin is absent.
  }
}

let nativeBackBridgeInstalled = false;

function consumeNativeBack(detail?: { canGoBack?: boolean }): boolean {
  if (typeof window === 'undefined') return false;

  const uiEvent = new CustomEvent('meristream:native-back', {
    cancelable: true,
    detail,
  });
  if (!window.dispatchEvent(uiEvent)) return true;

  const state = window.history.state || {};
  const route = String(state.meristream_route || '');
  const hasTransientOverlay = Boolean(state.meristream_native_overlay);
  const hasRoutedScreen = route === 'player' || route === 'details';
  const hasCatalogState = window.location.pathname !== '/'
    || Boolean(window.location.search)
    || Boolean(window.location.hash);

  if (hasTransientOverlay || hasRoutedScreen || hasCatalogState) {
    window.history.back();
    return true;
  }
  return false;
}

/**
 * Android hardware Back is intercepted by MainActivity and asks this shared
 * handler first. The official App plugin is a secondary path, not a single
 * point of failure.
 */
export function installNativeBackBridge(): void {
  if (!isNativeShell() || nativeBackBridgeInstalled || typeof window === 'undefined') return;
  nativeBackBridgeInstalled = true;

  (window as any).__meristreamHandleAndroidBack = () => consumeNativeBack();

  const app = nativePlugin('App');
  if (typeof app?.addListener !== 'function') return;

  const listener = app.addListener('backButton', (event: { canGoBack?: boolean }) => {
    if (consumeNativeBack(event)) return;

    if (typeof app.minimizeApp === 'function') {
      const task = app.minimizeApp();
      if (task?.catch) task.catch(() => {});
    }
  });
  if (listener?.catch) listener.catch(() => {});
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

export function publicAppUrl(pathOrQuery?: string): string {
  if (typeof window === 'undefined') return pathOrQuery || '';
  const origin = isNativeShell() ? backendBaseOrigin() : window.location.origin;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  try {
    return new URL(pathOrQuery || current || '/', origin || window.location.origin).toString();
  } catch {
    return pathOrQuery || current;
  }
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
