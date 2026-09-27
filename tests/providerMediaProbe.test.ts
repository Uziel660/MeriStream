import { describe, expect, it, vi } from 'vitest';
import { probeMedia } from '../tools/providerMediaProbe';

function response(body: string | Uint8Array, contentType: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

describe('live provider media probe', () => {
  it('accepts backend relay URLs without trying to fetch them from the probe process', async () => {
    const fetchImpl = vi.fn();

    await expect(probeMedia('/api/v1/playback/session/master.m3u8', {}, fetchImpl)).resolves.toEqual({
      host: 'meristream-backend',
      requiresBackendProxy: true,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('follows an HLS child playlist and checks that the first segment is media', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://cdn.example/master.m3u8') {
        return response('#EXTM3U\nvariant/index.m3u8\n', 'application/vnd.apple.mpegurl');
      }
      if (url === 'https://cdn.example/variant/index.m3u8') {
        return response('#EXTM3U\n#EXTINF:5,\nseg-1.ts\n', 'application/vnd.apple.mpegurl');
      }
      if (url === 'https://cdn.example/variant/seg-1.ts') {
        return response(new Uint8Array([0x47, ...new Uint8Array(187), 0x47, ...new Uint8Array(187), 0x47]), 'video/mp2t', 206);
      }
      throw new Error(`unexpected URL ${url}`);
    });

    await expect(probeMedia('https://cdn.example/master.m3u8', {}, fetchImpl)).resolves.toMatchObject({
      status: 200,
      hls: true,
      segmentStatus: 206,
      bytesRead: 377,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('recognizes a direct video response and requests only its first byte range', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Range: 'bytes=0-8191', Accept: '*/*' });
      return response(new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]), 'video/mp4', 206);
    });

    await expect(probeMedia('https://cdn.example/movie.mp4', {}, fetchImpl)).resolves.toMatchObject({
      status: 206,
      contentType: 'video/mp4',
      bytesRead: 8,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('rejects a successful HTTP response whose body is an HTML page instead of media', async () => {
    const fetchImpl = vi.fn(async () => response('<html>blocked</html>', 'text/html'));

    await expect(probeMedia('https://cdn.example/video.mp4', {}, fetchImpl)).resolves.toMatchObject({
      status: 200,
      error: 'response_not_media',
    });
  });
});
