export type PreferredQuality = 'auto' | '1080p' | '720p' | '480p';
export type SubtitlePosition = 'bottom' | 'center' | 'top';
export type ContrastMode = 'standard' | 'high';

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
};

const STORAGE_PREFIX = 'meristream_preferences_v1:';
export const APP_PREFERENCES_EVENT = 'meristream:preferences-changed';

function storageKey(userId?: string | null): string {
  return `${STORAGE_PREFIX}${String(userId || 'guest')}`;
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
      tmdbApiKey: typeof parsed.tmdbApiKey === 'string' ? parsed.tmdbApiKey.trim().slice(0, 128) : '',
      preferredLanguages: Array.isArray(parsed.preferredLanguages) ? parsed.preferredLanguages : DEFAULT_APP_PREFERENCES.preferredLanguages,
      preferredSubtitleLanguages: Array.isArray(parsed.preferredSubtitleLanguages) ? parsed.preferredSubtitleLanguages : DEFAULT_APP_PREFERENCES.preferredSubtitleLanguages,
    };
  } catch {
    return { ...DEFAULT_APP_PREFERENCES };
  }
}

export function saveAppPreferences(userId: string | null | undefined, preferences: AppPreferences): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(storageKey(userId), JSON.stringify(preferences));
  window.dispatchEvent(new CustomEvent(APP_PREFERENCES_EVENT, { detail: { userId: userId || 'guest' } }));
}

export function updateAppPreferences(userId: string | null | undefined, patch: Partial<AppPreferences>): AppPreferences {
  const next = { ...getAppPreferences(userId), ...patch };
  saveAppPreferences(userId, next);
  return next;
}
