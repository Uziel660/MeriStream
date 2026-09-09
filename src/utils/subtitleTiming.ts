export interface SubtitleTimingSettings {
  /** Video timestamp at which the independent subtitle adjustment begins. */
  startAt: number;
  /** Positive values delay subtitles; negative values make them appear earlier. */
  offset: number;
}

export const DEFAULT_SUBTITLE_TIMING: SubtitleTimingSettings = {
  startAt: 0,
  offset: 0,
};

/**
 * Returns the timestamp to use when looking up a subtitle cue.
 *
 * A positive offset delays the subtitle timeline. Keeping this calculation
 * separate from the player makes the sign convention explicit and testable.
 */
export function subtitleTimelineTime(
  videoTime: number,
  settings: SubtitleTimingSettings = DEFAULT_SUBTITLE_TIMING,
): number {
  const safeVideoTime = Number.isFinite(videoTime) ? Math.max(0, videoTime) : 0;
  const startAt = Number.isFinite(settings.startAt) ? Math.max(0, settings.startAt) : 0;
  const offset = Number.isFinite(settings.offset) ? settings.offset : 0;

  if (safeVideoTime < startAt) return safeVideoTime;
  return Math.max(0, safeVideoTime - offset);
}

/** Accepts seconds, MM:SS, or HH:MM:SS. */
export function parseSubtitleTime(value: string, allowNegative = false): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const sign = trimmed.startsWith('-') ? -1 : 1;
  const unsigned = trimmed.replace(/^[+-]/, '');
  const parts = unsigned.split(':');
  let seconds: number;

  if (parts.length === 1) {
    seconds = Number(unsigned);
  } else if (parts.length <= 3 && parts.every((part) => /^\d+(?:\.\d+)?$/.test(part))) {
    seconds = parts.reduce((total, part) => total * 60 + Number(part), 0);
  } else {
    return null;
  }

  if (!Number.isFinite(seconds) || (!allowNegative && sign < 0)) return null;
  const parsedSeconds = seconds * sign;
  return allowNegative ? parsedSeconds : Math.max(0, parsedSeconds);
}

export function formatSubtitleTime(seconds: number, allowNegative = false): string {
  const safeSeconds = Number.isFinite(seconds) ? seconds : 0;
  const sign = allowNegative && safeSeconds < 0 ? '-' : '';
  const absolute = Math.round(Math.abs(safeSeconds));
  const hours = Math.floor(absolute / 3600);
  const minutes = Math.floor((absolute % 3600) / 60);
  const remainder = absolute % 60;

  if (hours > 0) {
    return `${sign}${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
  }
  return `${sign}${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}
