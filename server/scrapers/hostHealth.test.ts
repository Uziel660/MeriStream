import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isHostBlacklisted,
  listHostHealth,
  probeStream,
  recordPlaybackResult,
  resetHostHealth,
} from "./hostHealth";
import { StreamHealthService } from "../streamHealthService";

afterEach(() => {
  resetHostHealth();
  vi.useRealTimers();
});

describe("host health probes", () => {
  it("GETs HLS and validates the manifest prefix", async () => {
    const fetchMock = vi.fn(async () => new Response("#EXTM3U\n#EXT-X-TARGETDURATION:6\n", { status: 200 }));
    const result = await probeStream("https://cdn.example/video.m3u8", { fetch: fetchMock });

    expect(result).toMatchObject({ ok: true, state: "online", status: 200 });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cdn.example/video.m3u8",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("GETs DASH and validates an MPD before marking the host online", async () => {
    const fetchMock = vi.fn(async () => new Response(
      "<?xml version=\"1.0\"?><MPD><Period><AdaptationSet><SegmentTemplate media=\"chunk-$Number$.m4s\" /></AdaptationSet></Period></MPD>",
      { status: 200, headers: { "content-type": "application/dash+xml" } },
    ));
    const result = await probeStream("https://cdn.example/video.mpd", { fetch: fetchMock });

    expect(result).toMatchObject({ ok: true, state: "online", status: 200 });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://cdn.example/video.mpd",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("rejects an empty HLS response even when the CDN returns 200", async () => {
    const fetchMock = vi.fn(async () => new Response("#EXTM3U\n#EXT-X-VERSION:6\n", { status: 200 }));
    const result = await probeStream("https://cdn.example/empty.m3u8", { fetch: fetchMock });

    expect(result).toMatchObject({ ok: false, state: "degraded", status: 200, reason: "invalid_manifest" });
  });

  it("falls back from MP4 HEAD to a small Range GET", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 405 }))
      .mockResolvedValueOnce(new Response("ftyp", { status: 206 }));
    const result = await probeStream("https://cdn.example/movie.mp4", { fetch: fetchMock });

    expect(result).toMatchObject({ ok: true, status: 206 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]).toEqual(expect.objectContaining({
      method: "GET",
      headers: expect.objectContaining({ Range: "bytes=0-100" }),
    }));
  });

  it("does not blacklist a host for signed-token 401/403 responses", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 401 }));
    const first = await probeStream("https://cdn.example/video.mp4?token=expired", { fetch: fetchMock });
    const second = await probeStream("https://cdn.example/video.mp4?token=expired-2", { fetch: fetchMock });

    expect(first).toMatchObject({ state: "degraded", reason: "auth_expired" });
    expect(second).toMatchObject({ state: "degraded", reason: "auth_expired" });
    expect(isHostBlacklisted("https://cdn.example/video.mp4")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(4); // HEAD + Range for each URL
  });

  it("opens a circuit only after consecutive failures", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 503 }));
    const url = "https://flaky.example/movie.mp4";
    const first = await probeStream(url, { fetch: fetchMock });
    const second = await probeStream(url, { fetch: fetchMock });
    const third = await probeStream(url, { fetch: fetchMock });

    expect(first).toMatchObject({ state: "degraded", reason: "http_5xx" });
    expect(second).toMatchObject({ state: "offline", reason: "http_5xx" });
    expect(third).toMatchObject({ state: "offline", reason: "circuit_open", fromCache: true });
    expect(fetchMock).toHaveBeenCalledTimes(4); // each failed MP4 probe did HEAD + Range
  });

  it("treats one timeout as degraded, not offline", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const url = "https://slow.example/movie.mp4";
    const pending = probeStream(url, { fetch: fetchMock, timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    const result = await pending;

    expect(result).toMatchObject({ state: "degraded", reason: "timeout" });
    expect(isHostBlacklisted(url)).toBe(false);
  });

  it("uses real playback signals as the primary host signal", () => {
    const url = "https://playback.example/movie.mp4";
    recordPlaybackResult(url, { ok: false, reason: "playback_timeout", latencyMs: 3000 });
    recordPlaybackResult(url, { ok: true, latencyMs: 200 });
    const health = recordPlaybackResult(url, { ok: true, latencyMs: 180 });

    expect(health.playbackAttempts).toBe(3);
    expect(health.playbackSuccesses).toBe(2);
    expect(health.state).toBe("online");
  });

  it("exposes cooldown and playback counters for every observed host", () => {
    const url = "https://metrics.example/movie.mp4";
    recordPlaybackResult(url, { ok: false, reason: "playback_timeout" });
    const snapshot = listHostHealth();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({ host: "metrics.example", consecutiveFailures: 1, playbackAttempts: 1 });
  });
});

describe("stream health stale-while-revalidate", () => {
  it("returns unknown immediately, then stale data while refreshing", async () => {
    let now = 0;
    let calls = 0;
    const service = new StreamHealthService({
      now: () => now,
      cacheTtlMs: 100,
      staleTtlMs: 1_000,
      probe: async (url) => {
        calls += 1;
        return { url, ok: true, state: "online", status: 200 };
      },
    });
    const url = "https://cdn.example/movie.mp4";
    expect((await service.getSnapshot([url])).results[0].state).toBe("unknown");
    await service.refresh([url]);
    expect(calls).toBe(1);
    now = 200;
    const stale = await service.getSnapshot([url]);
    expect(stale).toMatchObject({ stale: true });
    expect(stale.results[0]).toMatchObject({ ok: true, fromCache: true, cacheStale: true });
  });

  it("does not start speculative probes when the runtime budget is under pressure", async () => {
    const probe = vi.fn(async (url: string) => ({ url, ok: true, state: "online" as const }));
    const service = new StreamHealthService({ probe, allowRefresh: () => false });

    const snapshot = await service.getSnapshot(["https://cdn.example/movie.mp4"]);
    await Promise.resolve();

    expect(snapshot.results[0].state).toBe("unknown");
    expect(probe).not.toHaveBeenCalled();
  });
});
