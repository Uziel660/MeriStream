import { describe, it, expect } from 'vitest';
import { rankAndSortServers, scoreServer } from './streamOptimizer';

describe('streamOptimizer', () => {
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
        'https://mega.nz/file/1234', // Embed, 1080p -> Score: 50 + 40 + 8 = 98 (Health: buena)
        'https://example.com/video-480p.mp4', // Native, 480p -> Score: 50 + 10 + 15 = 75
        'https://example.com/video-4k.m3u8', // Native, 4K, HLS -> Score: 50 + 50 + 25 + 15 = 140
        'https://voe.sx/embed/123', // Embed, 1080p -> Score: 50 + 40 + 10 = 100 (Health: buena)
        'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4', // Direct Google, 1080p -> Score: 50 + 40 + 20 + 15 = 125
      ];

      const result = rankAndSortServers(urls);

      expect(result).toHaveLength(5);

      // Expected order by score descending:
      // 1. 4K m3u8 (140)
      // 2. Google Direct 1080p (125)
      // 3. Voe Embed 1080p (100)
      // 4. Mega Embed 1080p (98)
      // 5. Native 480p mp4 (75)

      expect(result[0].url).toBe('https://example.com/video-4k.m3u8');
      expect(result[1].url).toBe('https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4');
      expect(result[2].url).toBe('https://voe.sx/embed/123');
      expect(result[3].url).toBe('https://mega.nz/file/1234');
      expect(result[4].url).toBe('https://example.com/video-480p.mp4');

      // Additional assertions on the expected shape
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
