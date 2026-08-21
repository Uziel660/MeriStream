import { describe, it, expect } from 'vitest';
import { detectQualityFromUrl, scoreServer } from './streamOptimizer';

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
