import { describe, it, expect } from 'vitest';
import {
  detectQualityFromUrl,
  isEmbedUrl,
  rankAndSortServers,
  scoreServer,
  isRawWebpageUrl,
  hasExpiringSignature,
  shouldProxyDirectHost,
} from './streamOptimizer';

describe('streamOptimizer — URL honesty helpers', () => {
  describe('isRawWebpageUrl', () => {
    it('detects raw episode/detail pages as not playable', () => {
      const rawPages = [
        'https://www.animeflv.net/ver/rezero-kara-hajimeru-isekai-seikatsu-4th-season-1',
        'https://latanime.org/ver/frieren-episodio-1',
        'https://tioanime.com/ver/nige-jouzu-1',
        'https://wwv.veranimes.net/ver/koukaku-kidoutai-tv-2',
        'https://www.tvmaze.com/episodes/12192/breaking-bad-1x01-pilot',
        'https://www.tvmaze.com/shows/169/breaking-bad',
        'https://lamovie.org/peliculas/10-cosas',
        'https://www.tubepelis.com/pelicula/algo',
        'https://cinecalidad.am/pelicula/x.html',
      ];
      rawPages.forEach((u) => expect(isRawWebpageUrl(u)).toBe(true));
    });

    it('does not flag direct media or embeds', () => {
      const media = [
        'https://nika.playmudos.com/hls2/x/master.m3u8?st=1&e=2',
        'https://enc11.goodstream.one/hls2/a/b/master.m3u8',
        'https://a.mp4upload.com:183/d/x/y/video.mp4',
        'https://voe.sx/e/6x0dhtkkvgpi',
        '',
        null,
      ];
      media.forEach((u) => expect(isRawWebpageUrl(u as any)).toBe(false));
    });
  });

  describe('hasExpiringSignature', () => {
    it('flags signed HLS/MP4 with expiry params', () => {
      expect(
        hasExpiringSignature('https://cdn1017.cdn-tnmr.org/hls2/x/master.m3u8?st=abc&e=43200')
      ).toBe(true);
      expect(hasExpiringSignature('https://voe.sx/hlsv/x.m3u8?t=1&s=2&node=n')).toBe(true);
      expect(hasExpiringSignature('https://cdn.example/video.mp4?token=zzz')).toBe(true);
    });

    it('does not flag stable public CDNs or unsigned URLs', () => {
      expect(hasExpiringSignature('https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8')).toBe(false);
      expect(
        hasExpiringSignature('https://archive.org/download/his_girl_friday/his_girl_friday.mp4')
      ).toBe(false);
      expect(hasExpiringSignature('https://example.com/stream.m3u8')).toBe(false);
      expect(hasExpiringSignature('https://animeflv.net/ver/x-1')).toBe(false);
      expect(hasExpiringSignature('')).toBe(false);
      expect(hasExpiringSignature(null)).toBe(false);
    });
  });

  describe('shouldProxyDirectHost', () => {
    it('routes known CORS-aggressive CDNs via proxy first', () => {
      expect(shouldProxyDirectHost('https://enc12.goodstream.one/hls2/a/master.m3u8')).toBe(true);
      expect(shouldProxyDirectHost('https://hls.acek-cdn.com/hls2/01/08535/x.master.m3u8')).toBe(true);
      expect(shouldProxyDirectHost('https://example.com/video.m3u8')).toBe(false);
      expect(shouldProxyDirectHost(null)).toBe(false);
    });
  });

  describe('scoreServer — raw webpage invalidation (#17)', () => {
    it('marks tvmaze episode page as notPlayable with honest label', () => {
      const s = scoreServer('https://www.tvmaze.com/episodes/12192/breaking-bad-1x01-pilot', 0);
      expect(s.notPlayable).toBe(true);
      expect(s.score).toBe(-1000);
      expect(s.label.startsWith('No reproducible')).toBe(true);
    });

    it('keeps real streams playable', () => {
      const s = scoreServer('https://nika.playmudos.com/hls2/x/master.m3u8', 0);
      expect(s.notPlayable).toBeFalsy();
      expect(s.score).toBeGreaterThan(0);
    });

    it('ranks raw pages last in rankAndSortServers when alone they remain but marked', () => {
      const result = rankAndSortServers([
        'https://www.tvmaze.com/episodes/12192/breaking-bad-1x01-pilot',
        'https://example.com/stream.m3u8',
      ]);
      // La página cruda se descarta cuando hay streams reales
      expect(result).toHaveLength(1);
      expect(result[0].url).toContain('.m3u8');
    });
  });
});

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
        'https://cdn.example.com/content/movie.mp4',
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
        'https://byselapuix.com/embed/123',
        'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
      ];

      const result = rankAndSortServers(urls);

      // Big Buck Bunny / demo / sample nunca es video real -> debe quedar excluido
      expect(result).toHaveLength(4);
      expect(result.some((s) => s.url.toLowerCase().includes('bigbuckbunny') || s.url.toLowerCase().includes('/sample/'))).toBe(false);

      expect(result[0].url).toBe('https://example.com/video-4k.m3u8');
      expect(result[1].url).toBe('https://byselapuix.com/embed/123');
      expect(result[2].url).toBe('https://mega.nz/embed/1234');
      expect(result[3].url).toBe('https://example.com/video-480p.mp4');

      expect(result[0].quality).toBe('4K');
      expect(result[0].isEmbed).toBe(false);

      expect(result[1].quality).toBe('1080p');
      expect(result[1].isEmbed).toBe(true);
      expect(result[1].health).toBe('buena');
    });

    it('does not filter legitimate URLs that contain demo as substring inside another word', () => {
      const legit = [
        'https://cdn.example.com/demonstration/video-1080p.mp4',
        'https://demo.example.com/content/movie-720p.mp4',
        'https://example.com/videos/mydemo123.mp4',
        'https://cdn.example.com/content/sampled/clip-1080p.mp4',
      ];
      // Ninguna debe marcarse como placeholder por contener "demo"/"sample" dentro de otra palabra o en dominio
      legit.forEach((u) => {
        const s = scoreServer(u, 0);
        expect(s.notPlayable).toBeFalsy();
        expect(s.score).toBeGreaterThan(0);
      });
      const ranked = rankAndSortServers([...legit, 'https://example.com/video-4k.m3u8']);
      // demo/sample como segmento real sí se filtraría; estas no, deben permanecer
      expect(ranked).toHaveLength(5);
      expect(ranked.some((s) => s.url.includes('demonstration'))).toBe(true);
      expect(ranked.some((s) => s.url.includes('demo.example.com'))).toBe(true);

      // En cambio, segmento delimitado sí debe filtrarse
      const placeholderDemo = scoreServer('https://cdn.example.com/demo/video-1080p.mp4', 0);
      expect(placeholderDemo.notPlayable).toBe(true);
      expect(placeholderDemo.score).toBe(-1000);
      const placeholderSample = scoreServer('https://cdn.example.com/sample/clip.m3u8', 0);
      expect(placeholderSample.notPlayable).toBe(true);
      const withBunny = scoreServer('https://cdn.example.com/content/BigBuckBunny.mp4', 0);
      expect(withBunny.notPlayable).toBe(true);
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
