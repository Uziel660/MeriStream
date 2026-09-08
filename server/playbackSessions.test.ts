import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlaybackSessionStore, createPlaybackSessionHandlers } from "./playbackSessions";
import type { ResolvedStreamMeta } from "./resolvers";

function meta(original: string, url: string, refreshAfter: number, generation = "g1"): ResolvedStreamMeta {
  return {
    url, original_url: original, canonical_locator: original, is_proxyable: true, is_refreshable: true,
    resolved: true, type: "direct", provider: "Test", resolved_at: 100,
    expires_at: refreshAfter + 100, refresh_after: refreshAfter,
    resolution_id: generation, generation, expiration_source: "provider-soft-ttl",
  };
}

describe("PlaybackSessionStore", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("creates a session from existing resolution metadata without resolving twice", async () => {
    let calls = 0;
    const store = new PlaybackSessionStore({ resolver: async (original) => meta(original, "https://cdn.example/master.m3u8", 9_999, `g${++calls}`), now: () => 100 });
    const resolved = meta("https://embed.example/already-resolved", "https://cdn.example/master.m3u8", 9_999);
    const session = store.createFromResolved("https://embed.example/already-resolved", resolved);
    expect(session.current).toBe(resolved);
    expect(calls).toBe(0);
  });

  it("singleflights a proactive refresh and keeps signed URLs out of rewritten manifests", async () => {
    let now = 100;
    let calls = 0;
    const resolver = async (original: string) => {
      calls++;
      return meta(original, `https://cdn.example/master.m3u8?token=private-${calls}`, calls === 1 ? 101 : 5_000, `g${calls}`);
    };
    const store = new PlaybackSessionStore({ resolver, now: () => now });
    const session = await store.create("https://embed.example/watch/123");
    now = 102;
    const [first, second] = await Promise.all([store.upstream(session.id), store.upstream(session.id)]);
    expect(calls).toBe(2);
    expect(first.generation).toBe("g2");
    expect(second.generation).toBe("g2");

    const rewritten = store.rewriteManifest(session.id, "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin?token=private-2\"\nsegment-1.ts?token=private-2", first.url);
    expect(rewritten).not.toContain("private-2");
    expect(rewritten).toContain(`/api/v1/playback/${session.id}/resource/`);
  });

  it("forces exactly one refresh after concurrent 401/403 responses", async () => {
    let calls = 0;
    const store = new PlaybackSessionStore({ resolver: async (original) => meta(original, `https://cdn.example/${++calls}.m3u8`, 9_999, `g${calls}`), now: () => 100 });
    const session = await store.create("https://embed.example/a");
    const refreshed = await Promise.all([
      store.refreshForUpstreamStatus(session.id, 401),
      store.refreshForUpstreamStatus(session.id, 403),
    ]);
    expect(calls).toBe(2);
    expect(refreshed[0]?.generation).toBe("g2");
    expect(refreshed[1]?.generation).toBe("g2");
  });

  it("rebuilds a root-relative resource against the refreshed upstream base", async () => {
    let calls = 0;
    const store = new PlaybackSessionStore({ resolver: async (original) => meta(original, `https://cdn.example/v${++calls}/master.m3u8`, 9_999, `g${calls}`), now: () => 100 });
    const session = await store.create("https://embed.example/a");
    const rewritten = store.rewriteManifest(session.id, "part-1.ts", session.current.url);
    const resourceId = rewritten.split("/").at(-1)!;
    expect(store.resourceUrl(session.id, resourceId)).toBe("https://cdn.example/v1/part-1.ts");
    await store.refreshForUpstreamStatus(session.id, 403);
    expect(store.resourceUrl(session.id, resourceId)).toBe("https://cdn.example/v2/part-1.ts");
  });

  it("rewrites DASH BaseURL and expands opaque resources after template substitution", async () => {
    const store = new PlaybackSessionStore({ now: () => 100 });
    const session = store.createFromResolved(
      "https://embed.example/dash",
      meta("https://embed.example/dash", "https://cdn.example/v1/manifest.mpd", 9_999),
    );
    const raw = [
      "<?xml version=\"1.0\"?>",
      "<MPD><Period><AdaptationSet>",
      "<BaseURL>segments/</BaseURL>",
      "<SegmentTemplate media=\"chunk-$Number$.m4s\" initialization=\"init.mp4\" />",
      "</AdaptationSet></Period></MPD>",
    ].join("\n");
    const rewritten = store.rewriteDashManifest(session.id, raw, session.current.url);
    expect(rewritten).toContain("/api/v1/playback/");
    expect(rewritten).toContain("chunk-$Number$.m4s");
    expect(rewritten).not.toContain(">segments/<");
    const baseMatch = rewritten.match(/<BaseURL>([^<]+)<\/BaseURL>/i);
    expect(baseMatch?.[1]).toMatch(/\/resource\/[^/]+\/$/);
    const baseKey = baseMatch![1].split("/").at(-2)!;
    expect(store.resourceUrl(session.id, baseKey, "chunk-7.m4s"))
      .toBe("https://cdn.example/v1/segments/chunk-7.m4s");
  });

  it("rebases an absolute signed resource onto the renewed root token", async () => {
    let calls = 0;
    const store = new PlaybackSessionStore({
      resolver: async (original) => meta(
        original,
        `https://cdn-${calls + 1}.example/v${++calls}/master.m3u8?token=fresh-${calls}`,
        9_999,
        `g${calls}`,
      ),
      now: () => 100,
    });
    const session = await store.create("https://embed.example/absolute");
    const oldAbsolute = "https://cdn-1.example/v1/segments/part-1.ts?token=stale-1";
    const rewritten = store.rewriteManifest(session.id, oldAbsolute, session.current.url);
    const resourceId = rewritten.split("/").at(-1)!;
    expect(store.resourceUrl(session.id, resourceId)).toBe(oldAbsolute);

    await store.refreshForUpstreamStatus(session.id, 403);
    expect(store.resourceUrl(session.id, resourceId))
      .toBe("https://cdn-2.example/v2/segments/part-1.ts?token=fresh-2");
  });

  it("accepts a currently valid signed direct URL even without a renewable locator", async () => {
    const store = new PlaybackSessionStore({
      resolver: async () => ({ ...meta("", "https://cdn.example/a.m3u8", 9_999), canonical_locator: undefined, is_refreshable: false }),
      now: () => 100,
    });
    const session = await store.create("https://cdn.example/a.m3u8?exp=1");
    expect(session.original_url).toBe("https://cdn.example/a.m3u8?exp=1");
    expect(session.current.url).toBe("https://cdn.example/a.m3u8");
  });

  it("creates a short non-renewable session for a valid Vimeos s+e URL", async () => {
    const startSeconds = 1_900_000_000;
    const ttlSeconds = 120;
    const now = startSeconds * 1000 + 1_000;
    const signed = `https://s1.vimeos.net/master.m3u8?s=${startSeconds}&e=${ttlSeconds}`;
    const store = new PlaybackSessionStore({ now: () => now });
    const session = await store.create(signed);
    expect(session.current).toMatchObject({
      resolved: true,
      is_proxyable: true,
      is_refreshable: false,
      expires_at: (startSeconds + ttlSeconds) * 1000,
    });
    expect(session.current.canonical_locator).toBeUndefined();
  });

  it("does not retry or renew a non-renewable signed URL after upstream 403", async () => {
    let resolverCalls = 0;
    const signedMeta = {
      ...meta("https://cdn.example/a.m3u8?t=opaque", "https://cdn.example/a.m3u8?t=opaque", 9_999),
      canonical_locator: undefined,
      is_refreshable: false,
    };
    const store = new PlaybackSessionStore({
      resolver: async () => { resolverCalls += 1; return signedMeta; },
      now: () => 100,
    });
    const session = store.createFromResolved(signedMeta.original_url, signedMeta);
    expect(await store.refreshForUpstreamStatus(session.id, 403)).toBeUndefined();
    expect(resolverCalls).toBe(0);
  });

  it("rejects explicitly non-proxyable metadata", () => {
    const store = new PlaybackSessionStore({ now: () => 100 });
    const rejected = {
      ...meta("https://embed.example/dead", "https://cdn.example/dead.m3u8", 9_999),
      is_proxyable: false,
    };
    expect(() => store.createFromResolved("https://embed.example/dead", rejected))
      .toThrow("no admite entrega proxy");
  });

  it("deduplicates playlist resources and bounds abandoned sessions", async () => {
    let now = 100;
    const store = new PlaybackSessionStore({
      resolver: async (original) => meta(original, "https://cdn.example/master.m3u8", 9_999),
      now: () => now,
      maxSessions: 2,
      maxResourcesPerSession: 2,
    });
    const first = await store.create("https://embed.example/1");
    const once = store.rewriteManifest(first.id, "same.ts\nsame.ts", first.current.url);
    expect(new Set(once.split("\n"))).toHaveLength(1);
    now++;
    await store.create("https://embed.example/2");
    now++;
    await store.create("https://embed.example/3");
    expect(store.get(first.id)).toBeUndefined();
  });

  it("libera inmediatamente una sesión abandonada por cambio de servidor", () => {
    const store = new PlaybackSessionStore({ now: () => 100 });
    const session = store.createFromResolved(
      "https://embed.example/abandoned",
      meta("https://embed.example/abandoned", "https://cdn.example/master.m3u8", 9_999),
    );
    expect(store.stats().sessions).toBe(1);
    expect(store.delete(session.id)).toBe(true);
    expect(store.stats().sessions).toBe(0);
    expect(store.delete(session.id)).toBe(false);
  });

  it("uses T100TA defaults and evicts sessions and resources by LRU", () => {
    let now = 100;
    const store = new PlaybackSessionStore({ now: () => now });
    const sessions = Array.from({ length: 64 }, (_, index) => {
      now++;
      return store.createFromResolved(`https://embed.example/${index}`, meta(`https://embed.example/${index}`, "https://cdn.example/master.m3u8", 99_999));
    });
    // Touch the oldest session so the second-oldest becomes the eviction victim.
    expect(store.get(sessions[0].id)).toBeDefined();
    now++;
    store.createFromResolved("https://embed.example/64", meta("https://embed.example/64", "https://cdn.example/master.m3u8", 99_999));
    expect(store.get(sessions[0].id)).toBeDefined();
    expect(store.get(sessions[1].id)).toBeUndefined();
    expect(store.stats().sessions).toBe(64);

    const active = sessions[0];
    const keys = Array.from({ length: 300 }, (_, index) => store.registerResource(active.id, { upstreamUrl: `https://cdn.example/${index}.ts` }));
    expect(store.resourceUrl(active.id, keys[0])).toContain("/0.ts");
    const newest = store.registerResource(active.id, { upstreamUrl: "https://cdn.example/new.ts" });
    expect(store.resourceUrl(active.id, keys[0])).toContain("/0.ts");
    expect(store.resourceUrl(active.id, keys[1])).toBeUndefined();
    expect(store.resourceUrl(active.id, newest)).toContain("/new.ts");
    expect(store.stats().resources).toBe(300);
  });

  it("expires inactive sessions after the default 45 minutes", () => {
    let now = 0;
    const store = new PlaybackSessionStore({ now: () => now });
    const session = store.createFromResolved("https://embed.example/ttl", meta("https://embed.example/ttl", "https://cdn.example/master.m3u8", 99_999));
    now = 45 * 60 * 1000 + 1;
    expect(store.get(session.id)).toBeUndefined();
    expect(store.stats()).toEqual({ sessions: 0, refreshing: 0, resources: 0 });
  });

  it("balances relay callbacks on success and error paths", async () => {
    const store = new PlaybackSessionStore({ now: () => 100 });
    const session = store.createFromResolved("https://embed.example/relay", meta("https://embed.example/relay", "https://cdn.example/master.m3u8", 99_999));
    const starts: unknown[] = [];
    const ends: Array<{ status?: number; error?: unknown }> = [];
    const handlers = createPlaybackSessionHandlers(store, "/api/v1/playback", {
      onRelayStart: (event) => starts.push(event),
      onRelayEnd: (event) => ends.push(event),
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("#EXTM3U\nsegment.ts", {
      status: 200,
      headers: { "content-type": "application/vnd.apple.mpegurl" },
    })).mockRejectedValueOnce(new Error("upstream unavailable")));

    const request = () => Object.assign(new EventEmitter(), {
      params: { sessionId: session.id },
      header: () => undefined,
    });
    const response = () => Object.assign(new EventEmitter(), {
      writableEnded: false,
      headersSent: false,
      setHeader: vi.fn(),
      removeHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      type: vi.fn().mockReturnThis(),
      send: vi.fn(function (this: { writableEnded: boolean }) { this.writableEnded = true; return this; }),
      sendStatus: vi.fn(),
      end: vi.fn(),
    });
    const next = vi.fn();

    await handlers.masterManifest(request() as never, response() as never, next);
    await handlers.masterManifest(request() as never, response() as never, next);

    expect(starts).toHaveLength(2);
    expect(ends).toHaveLength(2);
    expect(ends[0]).toMatchObject({ status: 200 });
    expect(ends[0].error).toBeUndefined();
    expect(ends[1].error).toBeInstanceOf(Error);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("propagates Range and aborts upstream work when the client disconnects", async () => {
    const store = new PlaybackSessionStore({ now: () => 100 });
    const session = store.createFromResolved("https://embed.example/abort", meta("https://embed.example/abort", "https://cdn.example/master.m3u8", 99_999));
    let capturedSignal: AbortSignal | undefined;
    let capturedRange: string | null = null;
    let capturedUserAgent: string | null = null;
    let capturedReferer: string | null = null;
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
      capturedSignal = init?.signal as AbortSignal;
      const headers = new Headers(init?.headers);
      capturedRange = headers.get("range");
      capturedUserAgent = headers.get("user-agent");
      capturedReferer = headers.get("referer");
      return new Promise<Response>((_resolve, reject) => {
        capturedSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    }));
    const ended: unknown[] = [];
    const handler = createPlaybackSessionHandlers(store, "/api/v1/playback", { onRelayEnd: (event) => ended.push(event) }).masterManifest;
    const req = Object.assign(new EventEmitter(), {
      params: { sessionId: session.id },
      header: (name: string) => name === "range" ? "bytes=0-1023" : undefined,
    });
    const res = Object.assign(new EventEmitter(), { writableEnded: false, headersSent: false });
    const pending = handler(req as never, res as never, vi.fn());
    await Promise.resolve();
    req.emit("aborted");
    await pending;
    expect(capturedRange).toBe("bytes=0-1023");
    expect(capturedUserAgent).toContain("Mozilla/5.0");
    expect(capturedReferer).toBe("https://embed.example/abort");
    expect(capturedSignal?.aborted).toBe(true);
    expect(ended).toHaveLength(1);
  });
});
