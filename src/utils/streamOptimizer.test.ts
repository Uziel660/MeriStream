import { describe, it, expect } from 'vitest';
import {
  detectQualityFromUrl,
  isEmbedUrl,
  rankAndSortServers,
  scoreServer,
} from './streamOptimizer';

describe('streamOptimizer', () => {
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

  describe('rankAndSortServers', () => {
    it('should handle empty arrays', () => {
      expect(rankAndSortServers([])).toEqual([]);
    });

    it('should filter out invalid or falsy values', () => {
      const urls: any[] = [
        'https://example.com/video.mp4',
        null,
        undefined,
        '',
        123,
        'https://example.com/video2.mp4',
      ];
      const result = rankAndSortServers(urls);
      expect(result).toHaveLength(2);
      expect(result[0].url).toBe('https://example.com/video.mp4');
      expect(result[1].url).toBe('https://example.com/video2.mp4');
    });

    it('should filter out duplicates', () => {
      const urls = [
        'https://example.com/video.mp4',
        'https://example.com/video.mp4',
        'https://example.com/video.mp4',
      ];
      const result = rankAndSortServers(urls);
      expect(result).toHaveLength(1);
      expect(result[0].url).toBe('https://example.com/video.mp4');
    });

    it('should correctly score and sort different types of URLs', () => {
      const urls = [
        'https://mega.nz/file/1234',
        'https://example.com/video-480p.mp4',
        'https://example.com/video-4k.m3u8',
        'https://voe.sx/embed/123',
        'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
      ];

      const result = rankAndSortServers(urls);

      expect(result).toHaveLength(5);

      expect(result[0].url).toBe('https://example.com/video-4k.m3u8');
      expect(result[1].url).toBe('https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4');
      expect(result[2].url).toBe('https://voe.sx/embed/123');
      expect(result[3].url).toBe('https://mega.nz/embed/1234');
      expect(result[4].url).toBe('https://example.com/video-480p.mp4');

      expect(result[0].quality).toBe('4K');
      expect(result[0].isEmbed).toBe(false);

      expect(result[1].quality).toBe('1080p');
      expect(result[1].isEmbed).toBe(false);

      expect(result[2].isEmbed).toBe(true);
      expect(result[2].health).toBe('buena');
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
