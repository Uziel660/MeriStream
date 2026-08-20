import { describe, it, expect } from 'vitest';
import { scoreServer } from './streamOptimizer';

describe('streamOptimizer.scoreServer', () => {
  it('scores 4K Mux HLS stream highest', () => {
    const url = 'https://mux.dev/video-4k.m3u8';
    const server = scoreServer(url, 0);

    // base: 50
    // 4K: +50 = 100
    // .m3u8: +25 = 125
    // mux.dev: +20 = 145
    // !isEmbed: +15 = 160
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

    // base: 50
    // 1080p: +40 = 90
    // !isEmbed: +15 = 105
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

    // base: 50
    // 720p: +25 = 75
    // isEmbed: true
    // voe.sx health = 'buena': +10 = 85
    expect(server.quality).toBe('720p');
    expect(server.isEmbed).toBe(true);
    expect(server.score).toBe(85);
    expect(server.health).toBe('buena');
    expect(server.provider).toBe('VOE HighSpeed');
  });

  it('scores 480p Mega embed properly', () => {
    const url = 'https://mega.nz/file-480p';
    const server = scoreServer(url, 3);

    // base: 50
    // 480p: +10 = 60
    // isEmbed: true
    // mega.nz health = 'buena': +8 = 68
    expect(server.quality).toBe('480p');
    expect(server.isEmbed).toBe(true);
    expect(server.score).toBe(68);
    expect(server.health).toBe('buena');
    expect(server.provider).toBe('Mega Cloud');
  });

  it('scores Auto HD standard HLS stream properly', () => {
    const url = 'https://example.com/stream.m3u8';
    const server = scoreServer(url, 4);

    // base: 50
    // Auto HD: +38 = 88
    // .m3u8: +25 = 113
    // !isEmbed: +15 = 128
    expect(server.quality).toBe('Auto HD');
    expect(server.isEmbed).toBe(false);
    expect(server.score).toBe(128);
    expect(server.health).toBe('excelente');
  });

  it('scores normal embed with standard stability properly', () => {
    const url = 'https://streamtape.com/e/video-1080p';
    const server = scoreServer(url, 5);

    // base: 50
    // 1080p: +40 = 90
    // isEmbed: true
    // health = 'estable' (no extra score)
    expect(server.quality).toBe('1080p');
    expect(server.isEmbed).toBe(true);
    expect(server.score).toBe(90);
    expect(server.health).toBe('estable');
    expect(server.provider).toBe('Streamtape CDN');
  });

  it('scores Google Fast Direct correctly', () => {
    const url = 'https://storage.googleapis.com/test-1080p.mp4';
    const server = scoreServer(url, 6);

    // base: 50
    // 1080p: +40 = 90
    // googleapis: +20 = 110
    // !isEmbed: +15 = 125
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
