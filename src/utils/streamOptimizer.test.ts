import { describe, it, expect } from 'bun:test';
import { detectQualityFromUrl } from './streamOptimizer';

describe('detectQualityFromUrl', () => {
  it('detects 4K quality', () => {
    expect(detectQualityFromUrl('http://example.com/video_4k.mp4')).toBe('4K');
    expect(detectQualityFromUrl('http://example.com/video_2160p.mp4')).toBe('4K');
    expect(detectQualityFromUrl('http://example.com/video_4K.mp4')).toBe('4K'); // case insensitive
  });

  it('detects 1080p quality', () => {
    expect(detectQualityFromUrl('http://example.com/video_1080p.mp4')).toBe('1080p');
    expect(detectQualityFromUrl('http://example.com/video_fullhd.mp4')).toBe('1080p');
    expect(detectQualityFromUrl('http://example.com/video_fhd.mp4')).toBe('1080p');
    expect(detectQualityFromUrl('http://example.com/video_1080P.mp4')).toBe('1080p');
  });

  it('detects 720p quality', () => {
    expect(detectQualityFromUrl('http://example.com/video_720p.mp4')).toBe('720p');
    expect(detectQualityFromUrl('http://example.com/video_hd.mp4')).toBe('720p');
  });

  it('detects 480p quality', () => {
    expect(detectQualityFromUrl('http://example.com/video_480p.mp4')).toBe('480p');
    expect(detectQualityFromUrl('http://example.com/video_sd.mp4')).toBe('480p');
  });

  it('detects Auto HD quality', () => {
    expect(detectQualityFromUrl('http://example.com/playlist.m3u8')).toBe('Auto HD');
    expect(detectQualityFromUrl('http://mux.dev/video.mp4')).toBe('Auto HD');
  });

  it('returns 1080p as default for unknown qualities', () => {
    expect(detectQualityFromUrl('http://example.com/video.mp4')).toBe('1080p');
    expect(detectQualityFromUrl('http://example.com/unknown')).toBe('1080p');
    expect(detectQualityFromUrl('')).toBe('1080p');
  });
});
