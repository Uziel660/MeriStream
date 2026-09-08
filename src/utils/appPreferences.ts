export type PreferredQuality = 'auto' | '1080p' | '720p' | '480p';
export type SubtitlePosition = 'bottom' | 'center' | 'top';

export interface AppPreferences {
  preferredLanguages: string[];
  preferredSubtitleLanguages: string[];
  defaultQuality: PreferredQuality;
  subtitlePosition: SubtitlePosition;
  subtitleScale: 'small' | 'normal' | 'large';
  reduceMotion: boolean;
}

export const DEFAULT_APP_PREFERENCES: AppPreferences = {
  preferredLanguages: ['es-419', 'es', 'en', 'ja'],
  preferredSubtitleLanguages: ['es-419', 'es', 'en'],
  defaultQuality: 'auto',
  subtitlePosition: 'bottom',
  subtitleScale: 'normal',
  reduceMotion: false,
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
    return {
      ...DEFAULT_APP_PREFERENCES,
      ...parsed,
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

