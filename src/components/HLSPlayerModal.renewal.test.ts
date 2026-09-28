import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import { renewPlayerServer } from './HLSPlayerModal';
import type { ScoredServer } from '../utils/streamOptimizer';

vi.mock('../api/client', () => ({
  api: { resolveEmbed: vi.fn() },
  getAuthToken: vi.fn(),
}));

const originalServer = {
  id: 'server-1',
  url: 'https://cdn.example/old.m3u8?token=old',
  original_url: 'https://embed.example/watch/1',
  canonical_locator: 'https://embed.example/watch/1',
  label: 'CDN',
  provider: 'CDN',
  quality: '1080p',
  isEmbed: false,
  streamType: 'direct',
  score: 80,
  health: 'excelente',
} as ScoredServer;

describe('renewPlayerServer', () => {
  beforeEach(() => vi.resetAllMocks());

  it('ignores a stale attempt before resolving its embed', async () => {
    await renewPlayerServer({
      server: originalServer,
      serverIndex: 0,
      attemptId: 7,
      isCurrentAttempt: () => false,
      setServers: vi.fn(),
      videoRef: { current: null },
      hlsRef: { current: null },
      dashRef: { current: null },
      attachSource: vi.fn(),
    });

    expect(api.resolveEmbed).not.toHaveBeenCalled();
  });

  it('discards a renewal that becomes stale while the resolver is pending', async () => {
    let resolve!: (value: any) => void;
    vi.mocked(api.resolveEmbed).mockReturnValue(new Promise((done) => { resolve = done; }));
    let current = true;
    const setServers = vi.fn();
    const hls = { loadSource: vi.fn() };
    const renewal = renewPlayerServer({
      server: originalServer,
      serverIndex: 0,
      attemptId: 7,
      isCurrentAttempt: () => current,
      setServers,
      videoRef: { current: null },
      hlsRef: { current: hls },
      dashRef: { current: null },
      attachSource: vi.fn(),
    });

    current = false;
    resolve({ resolved: true, url: 'https://cdn.example/stale.m3u8' });
    await renewal;

    expect(setServers).not.toHaveBeenCalled();
    expect(hls.loadSource).not.toHaveBeenCalled();
  });

  it('updates the renewed server and reattaches HLS without losing playback position', async () => {
    vi.mocked(api.resolveEmbed).mockResolvedValue({
      resolved: true,
      url: 'https://cdn.example/renewed.m3u8?token=new',
      canonical_locator: 'https://embed.example/watch/1',
      generation: 'generation-2',
      is_refreshable: true,
    } as any);
    const video = { currentTime: 42, paused: false, play: vi.fn().mockResolvedValue(undefined) };
    const hls = { loadSource: vi.fn() };
    let updated: ScoredServer[] = [originalServer];
    const setServers = vi.fn((updater: (previous: ScoredServer[]) => ScoredServer[]) => { updated = updater(updated); });

    await renewPlayerServer({
      server: originalServer,
      serverIndex: 0,
      attemptId: 7,
      isCurrentAttempt: () => true,
      setServers,
      videoRef: { current: video as unknown as HTMLVideoElement },
      hlsRef: { current: hls },
      dashRef: { current: null },
      attachSource: vi.fn(),
    });

    expect(api.resolveEmbed).toHaveBeenCalledWith('https://embed.example/watch/1');
    expect(updated[0]).toMatchObject({ url: 'https://cdn.example/renewed.m3u8?token=new', generation: 'generation-2' });
    const renewedSource = new URL(String(hls.loadSource.mock.calls[0][0]), 'https://meristream.example');
    expect(renewedSource.pathname).toBe('/api/v1/proxy/stream');
    expect(renewedSource.searchParams.get('url')).toBe('https://cdn.example/renewed.m3u8?token=new');
    expect(renewedSource.searchParams.get('referer')).toBe('https://embed.example/watch/1');
    expect(video.currentTime).toBe(42);
    expect(video.play).toHaveBeenCalledOnce();
  });

  it('resets dash.js before attaching the renewed source', async () => {
    vi.mocked(api.resolveEmbed).mockResolvedValue({ resolved: true, url: 'https://cdn.example/new.mpd' } as any);
    const dash = { reset: vi.fn() };
    const dashRef = { current: dash as any };
    const attachSource = vi.fn();

    await renewPlayerServer({
      server: { ...originalServer, url: 'https://cdn.example/old.mpd' },
      serverIndex: 0,
      attemptId: 2,
      isCurrentAttempt: () => true,
      setServers: vi.fn(),
      videoRef: { current: null },
      hlsRef: { current: null },
      dashRef,
      attachSource,
    });

    expect(dash.reset).toHaveBeenCalledOnce();
    expect(dashRef.current).toBeNull();
    expect(attachSource).toHaveBeenCalledWith('https://cdn.example/new.mpd');
  });
});
