import { describe, expect, it } from 'vitest';
import {
  formatSubtitleTime,
  parseSubtitleTime,
  subtitleTimelineTime,
} from './subtitleTiming';

describe('subtitle timing', () => {
  it('keeps the original subtitle timeline before the configured start point', () => {
    expect(subtitleTimelineTime(119, { startAt: 120, offset: 30 })).toBe(119);
  });

  it('delays subtitles when a positive offset is applied', () => {
    expect(subtitleTimelineTime(180, { startAt: 120, offset: 30 })).toBe(150);
  });

  it('accepts minute and second input, including negative offsets', () => {
    expect(parseSubtitleTime('01:30')).toBe(90);
    expect(parseSubtitleTime('-00:12', true)).toBe(-12);
    expect(parseSubtitleTime('-00:12')).toBeNull();
  });

  it('formats values back into a compact player-friendly timestamp', () => {
    expect(formatSubtitleTime(90)).toBe('01:30');
    expect(formatSubtitleTime(-12, true)).toBe('-00:12');
  });
});
