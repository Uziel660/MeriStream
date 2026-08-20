import { describe, it, expect } from 'bun:test';
import { isEmbedUrl } from './streamOptimizer';

describe('isEmbedUrl', () => {
  it('should return false for empty strings', () => {
    expect(isEmbedUrl('')).toBe(false);
  });

  it('should return true for known embed URLs', () => {
    const embedUrls = [
      'https://player.zilla-networks.com/video/123',
      'https://example.com/embed/123',
      'https://example.com/e/123',
      'https://voe.sx/123',
      'https://mega.nz/file/123',
      'https://www.mp4upload.com/123',
      'https://streamtape.com/v/123',
      'https://byselapuix.com/123',
      'https://ok.ru/videoembed/123',
      'https://streamwish.com/123',
      'https://filemoon.sx/123'
    ];

    embedUrls.forEach(url => {
      expect(isEmbedUrl(url)).toBe(true);
    });
  });

  it('should be case insensitive', () => {
    const embedUrlsUppercase = [
      'https://PLAYER.ZILLA-NETWORKS.COM/video/123',
      'https://example.com/EMBED/123',
      'https://example.com/E/123',
      'https://VOE.SX/123',
      'https://MEGA.NZ/file/123',
      'https://www.MP4UPLOAD.COM/123',
      'https://STREAMTAPE.COM/v/123',
      'https://BYSELAPUIX.COM/123',
      'https://OK.RU/VIDEOEMBED/123',
      'https://STREAMWISH.COM/123',
      'https://FILEMOON.SX/123'
    ];

    embedUrlsUppercase.forEach(url => {
      expect(isEmbedUrl(url)).toBe(true);
    });
  });

  it('should return false for direct video/HLS URLs', () => {
    const directUrls = [
      'https://example.com/video.mp4',
      'https://example.com/stream.m3u8',
      'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
      'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
      'https://example.com/video?quality=1080p'
    ];

    directUrls.forEach(url => {
      expect(isEmbedUrl(url)).toBe(false);
    });
  });

  it('should return false for invalid or unrelated URLs', () => {
    const invalidUrls = [
      'https://google.com',
      'random-string',
      'https://example.com/path',
      'http://localhost:3000'
    ];

    invalidUrls.forEach(url => {
      expect(isEmbedUrl(url)).toBe(false);
    });
  });
});
