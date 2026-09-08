export type PreferredQuality = 'auto' | '1080p' | '720p' | '480p';
export type SubtitlePosition = 'bottom' | 'center' | 'top';
export type ContrastMode = 'standard' | 'high';
export type PerformanceMode = 'auto' | 'quality' | 'balanced' | 'low';

export interface AppPreferences {
  preferredLanguages: string[];
  preferredSubtitleLanguages: string[];
  defaultQuality: PreferredQuality;
  subtitlePosition: SubtitlePosition;
  subtitleScale: 'small' | 'normal' | 'large';
  reduceMotion: boolean;
  /** Optional per-user TMDB key. It is kept in this browser profile and sent
   * only to MeriStream's same-origin catalog endpoints. */
  tmdbApiKey: string;
  contrast: ContrastMode;
  /** Controls purely client-side visual cost. No playback/provider contract
   * depends on this value. */
  performanceMode: PerformanceMode;
  /** Keeps the manual source switcher discoverable even when the automatic
   * cascade currently has a single candidate. */
  showServerSelector: boolean;
}

export const DEFAULT_APP_PREFERENCES: AppPreferences = {
  preferredLanguages: ['es-419', 'es', 'en', 'ja'],
  preferredSubtitleLanguages: ['es-419', 'es', 'en'],
  defaultQuality: 'auto',
  subtitlePosition: 'bottom',
  subtitleScale: 'normal',
  reduceMotion: false,
  tmdbApiKey: '',
  contrast: 'standard',
  performanceMode: 'auto',
  showServerSelector: false,
};

const STORAGE_PREFIX = 'meristream_preferences_v1:';
export const APP_PREFERENCES_EVENT = 'meristream:preferences-changed';
const LEGACY_SERVER_SELECTOR_KEY = 'voidstream_show_server_selector';
const LEGACY_SERVER_SELECTOR_EVENT = 'voidstream:server-selector-changed';

function storageKey(userId?: string | null): string {
  return `${STORAGE_PREFIX}${String(userId || 'guest')}`;
}

function normalizePerformanceMode(value: unknown): PerformanceMode {
  return value === 'quality' || value === 'balanced' || value === 'low' ? value : 'auto';
}

export function getAppPreferences(userId?: string | null): AppPreferences {
  if (typeof window === 'undefined') return { ...DEFAULT_APP_PREFERENCES };
  try {
    const raw = window.localStorage.getItem(storageKey(userId));
    if (!raw) return { ...DEFAULT_APP_PREFERENCES };
    const parsed = JSON.parse(raw) as Partial<AppPreferences>;
    const contrast = parsed.contrast === 'high' ? 'high' : 'standard';
    return {
      ...DEFAULT_APP_PREFERENCES,
      ...parsed,
      contrast,
      performanceMode: normalizePerformanceMode(parsed.performanceMode),
      showServerSelector: parsed.showServerSelector === true,
      tmdbApiKey: typeof parsed.tmdbApiKey === 'string' ? parsed.tmdbApiKey.trim().slice(0, 128) : '',
      preferredLanguages: Array.isArray(parsed.preferredLanguages) ? parsed.preferredLanguages : DEFAULT_APP_PREFERENCES.preferredLanguages,
      preferredSubtitleLanguages: Array.isArray(parsed.preferredSubtitleLanguages) ? parsed.preferredSubtitleLanguages : DEFAULT_APP_PREFERENCES.preferredSubtitleLanguages,
    };
  } catch {
    return { ...DEFAULT_APP_PREFERENCES };
  }
}

/**
 * Applies only client-side presentation preferences and bridges the historical
 * server-selector flag consumed by HLSPlayerModal. Keeping the bridge here
 * makes the setting effectively profile-specific without changing any player
 * or provider contract.
 */
export function applyAppPreferencesToDocument(userId?: string | null): AppPreferences {
  const preferences = getAppPreferences(userId);
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.msContrast = preferences.contrast;
    document.documentElement.dataset.msReduceMotion = preferences.reduceMotion ? 'true' : 'false';
    document.documentElement.dataset.msPerformance = preferences.performanceMode;
  }
  if (typeof window !== 'undefined') {
    const nextSelectorValue = preferences.showServerSelector ? 'true' : 'false';
    if (window.localStorage.getItem(LEGACY_SERVER_SELECTOR_KEY) !== nextSelectorValue) {
      window.localStorage.setItem(LEGACY_SERVER_SELECTOR_KEY, nextSelectorValue);
      window.dispatchEvent(new Event(LEGACY_SERVER_SELECTOR_EVENT));
    }
  }
  return preferences;
}

export function saveAppPreferences(userId: string | null | undefined, preferences: AppPreferences): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(storageKey(userId), JSON.stringify(preferences));
  applyAppPreferencesToDocument(userId);
  window.dispatchEvent(new CustomEvent(APP_PREFERENCES_EVENT, { detail: { userId: userId || 'guest' } }));
}

export function updateAppPreferences(userId: string | null | undefined, patch: Partial<AppPreferences>): AppPreferences {
  const next = { ...getAppPreferences(userId), ...patch };
  saveAppPreferences(userId, next);
  return next;
}
