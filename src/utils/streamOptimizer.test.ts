import { describe, it, expect } from 'vitest';
import { isEmbedUrl, scoreServer } from './streamOptimizer';

describe('streamOptimizer', () => {
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

  describe('scoreServer', () => {
    it('scores 4K Mux HLS stream highest', () => {
      const url = 'https://mux.dev/video-4k.m3u8';
      const server = scoreServer(url, 0);

      expect(server.quality).toBe('4K');
      expect(server.isEmbed).toBe(false);
      expect(server.score).toBe(160);
      expect(server.health).toBe('excelente');
      expect(server.provider).toBe('CDN Ultra HLS (Rápido)');
      expect(server.label).toBe('[4K] CDN Ultra HLS (Rápido)');
    });

    it('scores 1080p direct MP4 properly', () => {
      const url = 'https://example.com/video-1080p.mp4';
      const server = scoreServer(url, 1);

      expect(server.quality).toBe('1080p');
      expect(server.isEmbed).toBe(false);
      expect(server.score).toBe(105);
      expect(server.health).toBe('excelente');
      expect(server.provider).toBe('Direct MP4 2');
      expect(server.label).toBe('[1080p] Direct MP4 2');
    });

    it('scores 720p VOE embed properly', () => {
      const url = 'https://voe.sx/video-720p';
      const server = scoreServer(url, 2);

      expect(server.quality).toBe('720p');
      expect(server.isEmbed).toBe(true);
      expect(server.score).toBe(85);
      expect(server.health).toBe('buena');
      expect(server.provider).toBe('VOE HighSpeed');
    });

    it('scores 480p Mega embed properly', () => {
      const url = 'https://mega.nz/file-480p';
      const server = scoreServer(url, 3);

      expect(server.quality).toBe('480p');
      expect(server.isEmbed).toBe(true);
      expect(server.score).toBe(68);
      expect(server.health).toBe('buena');
      expect(server.provider).toBe('Mega Cloud');
    });

    it('scores Auto HD standard HLS stream properly', () => {
      const url = 'https://example.com/stream.m3u8';
      const server = scoreServer(url, 4);

      expect(server.quality).toBe('Auto HD');
      expect(server.isEmbed).toBe(false);
      expect(server.score).toBe(128);
      expect(server.health).toBe('excelente');
    });

    it('scores normal embed with standard stability properly', () => {
      const url = 'https://streamtape.com/e/video-1080p';
      const server = scoreServer(url, 5);

      expect(server.quality).toBe('1080p');
      expect(server.isEmbed).toBe(true);
      expect(server.score).toBe(90);
      expect(server.health).toBe('estable');
      expect(server.provider).toBe('Streamtape CDN');
    });

    it('scores Google Fast Direct correctly', () => {
      const url = 'https://storage.googleapis.com/test-1080p.mp4';
      const server = scoreServer(url, 6);

      expect(server.quality).toBe('1080p');
      expect(server.isEmbed).toBe(false);
      expect(server.score).toBe(105);
      expect(server.health).toBe('excelente');
      expect(server.provider).toBe('Google Fast Direct');
    });

    it('ensures ID contains valid components', () => {
      const url = 'https://example.com/test-1080p.mp4';
      const server = scoreServer(url, 7);

      expect(server.id).toMatch(/^server-7-\d+$/);
    });
  });
});
