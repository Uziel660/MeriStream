import { describe, expect, it } from 'vitest';
import { proxiedStreamUrl } from './proxiedUrl';

describe('proxied stream URLs', () => {
  it('keeps empty sources empty', () => {
    expect(proxiedStreamUrl('')).toBe('');
  });

  it('preserves internal playback routes instead of proxying them again', () => {
    const result = proxiedStreamUrl('/api/v1/playback/sessions/session-1/master.m3u8');
    const parsed = new URL(result, 'https://meristream.example');

    expect(parsed.pathname).toBe('/api/v1/playback/sessions/session-1/master.m3u8');
    expect(parsed.search).toBe('');
  });

  it('proxies external streams and preserves encoded title and provider metadata', () => {
    const result = proxiedStreamUrl('https://cdn.example/video.m3u8?token=a%2Fb', 'Título / 1', 'Provider One');
    const parsed = new URL(result, 'https://meristream.example');

    expect(parsed.pathname).toBe('/api/v1/proxy/stream');
    expect(parsed.searchParams.get('url')).toBe('https://cdn.example/video.m3u8?token=a%2Fb');
    expect(parsed.searchParams.get('title')).toBe('Título / 1');
    expect(parsed.searchParams.get('provider')).toBe('Provider One');
  });

  it('preserves the referer required by a provider when proxying its stream', () => {
    const result = proxiedStreamUrl(
      'https://cdn.example/video.m3u8',
      'Título',
      'Provider One',
      'https://provider.example/watch/episode-1',
    );
    const parsed = new URL(result, 'https://meristream.example');

    expect(parsed.searchParams.get('url')).toBe('https://cdn.example/video.m3u8');
    expect(parsed.searchParams.get('referer')).toBe('https://provider.example/watch/episode-1');
  });
});
