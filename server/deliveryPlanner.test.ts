import { describe, expect, it } from "vitest";
import type { ResolvedStreamMeta } from "./resolvers";
import {
  buildResolveDeliveryResponse,
  DeliveryPlanner,
  ResolutionCoordinator,
  ResolutionLeaseCache,
} from "./deliveryPlanner";

const NOW = 1_800_000_000_000;

function meta(overrides: Partial<ResolvedStreamMeta> = {}): ResolvedStreamMeta {
  return {
    url: "https://media.unknown.test/master.m3u8?token=secret",
    original_url: "https://embed.test/e/abc",
    resolved: true,
    type: "direct",
    provider: "Unknown",
    is_proxyable: true,
    is_refreshable: true,
    resolved_at: NOW,
    refresh_after: NOW + 60_000,
    expires_at: NOW + 120_000,
    resolution_id: "resolution-1",
    generation: "resolution-1",
    expiration_source: "provider-soft-ttl",
    canonical_locator: "https://embed.test/e/abc-canonical",
    ...overrides,
  };
}

describe("DeliveryPlanner", () => {
  const planner = new DeliveryPlanner({
    directProviders: ["Browser CDN"],
    directHosts: ["direct.example"],
  });

  it("uses embed for unresolved and embed responses", () => {
    expect(planner.classify(meta({ resolved: false }))).toBe("embed");
    expect(planner.classify(meta({ type: "embed" }))).toBe("embed");
  });

  it("requires proxy whenever meaningful upstream headers exist", () => {
    expect(planner.classify(meta({ provider: "Browser CDN", requiredHeaders: { Referer: "https://vimeos.net/" } })))
      .toBe("proxy_required");
    expect(planner.classify(meta({ requiredHeaders: {} }))).toBe("direct_trial");
  });

  it("recognizes configured providers and exact or child hosts", () => {
    expect(planner.classify(meta({ provider: " browser cdn " }))).toBe("direct");
    expect(planner.classify(meta({ url: "https://direct.example/video.m3u8" }))).toBe("direct");
    expect(planner.classify(meta({ url: "https://edge.direct.example/video.m3u8" }))).toBe("direct");
    expect(planner.classify(meta({ url: "https://notdirect.example/video.m3u8" }))).toBe("direct_trial");
  });

  it("serializes defensively without mutating resolver metadata", () => {
    const source = meta({ requiredHeaders: { Referer: "https://embed.test/" } });
    const response = buildResolveDeliveryResponse(source, "regex_fast", planner);

    expect(response.delivery_mode).toBe("proxy_required");
    expect(response.strategy).toBe("regex_fast");
    expect(source).not.toHaveProperty("delivery_mode");
    response.requiredHeaders!.Referer = "changed";
    expect(source.requiredHeaders!.Referer).toBe("https://embed.test/");
  });
});

describe("ResolutionLeaseCache", () => {
  it("rechaza metadata parcial sin lanzar cuando no existe resolution_id", () => {
    const cache = new ResolutionLeaseCache({ now: () => NOW });
    expect(() => cache.put({
      url: "https://cdn.test/master.m3u8?t=opaque",
      original_url: "https://cdn.test/master.m3u8?t=opaque",
      resolved: true,
      type: "direct",
      provider: "Servidor",
      is_refreshable: false,
    })).not.toThrow();
    expect(cache.size).toBe(0);
  });

  it("requires a matching stable locator and never accepts the upstream URL", () => {
    const cache = new ResolutionLeaseCache({ now: () => NOW });
    const source = meta();
    expect(cache.put(source)).toBe(true);

    expect(cache.get(source.resolution_id, source.original_url)?.resolution_id).toBe(source.resolution_id);
    expect(cache.get(source.resolution_id, source.canonical_locator!)?.resolution_id).toBe(source.resolution_id);
    expect(cache.get(source.resolution_id, "https://attacker.test/embed")).toBeUndefined();
    expect(cache.get(source.resolution_id, source.url)).toBeUndefined();
  });

  it("caches a proxyable signed lease without pretending it is renewable", () => {
    const cache = new ResolutionLeaseCache({ now: () => NOW });
    const signed = meta({
      url: "https://cdn.test/master.m3u8?s=1800000000&e=120",
      original_url: "https://cdn.test/master.m3u8?s=1800000000&e=120",
      canonical_locator: undefined,
      is_proxyable: true,
      is_refreshable: false,
      refresh_after: NOW + 60_000,
      expires_at: NOW + 120_000,
    });
    expect(cache.put(signed)).toBe(true);
    expect(cache.get(signed.resolution_id!, signed.original_url)).toMatchObject({
      is_proxyable: true,
      is_refreshable: false,
      canonical_locator: undefined,
    });
  });

  it("expires at the earliest refresh or hard-expiry boundary", () => {
    let now = NOW;
    const cache = new ResolutionLeaseCache({ now: () => now });
    cache.put(meta({ refresh_after: NOW + 10, expires_at: NOW + 100 }));
    now = NOW + 10;

    expect(cache.get("resolution-1", "https://embed.test/e/abc")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("evicts the least-recently-used lease", () => {
    const cache = new ResolutionLeaseCache({ maxEntries: 2, now: () => NOW });
    cache.put(meta({ resolution_id: "one" }));
    cache.put(meta({ resolution_id: "two", original_url: "https://embed.test/e/two" }));
    expect(cache.get("one", "https://embed.test/e/abc")).toBeDefined();
    cache.put(meta({ resolution_id: "three", original_url: "https://embed.test/e/three" }));

    expect(cache.get("two", "https://embed.test/e/two")).toBeUndefined();
    expect(cache.get("one", "https://embed.test/e/abc")).toBeDefined();
    expect(cache.get("three", "https://embed.test/e/three")).toBeDefined();
  });

  it("never exposes or mutates stored metadata", () => {
    const cache = new ResolutionLeaseCache({ now: () => NOW });
    const source = meta({ requiredHeaders: { Origin: "https://embed.test" } });
    cache.put(source);

    source.url = "https://mutated-after-put.test/video.m3u8";
    source.requiredHeaders!.Origin = "mutated-after-put";
    const first = cache.get("resolution-1", "https://embed.test/e/abc")!;
    expect(first.url).toContain("media.unknown.test");
    expect(first.requiredHeaders!.Origin).toBe("https://embed.test");

    first.url = "https://mutated-after-get.test/video.m3u8";
    first.requiredHeaders!.Origin = "mutated-after-get";
    const second = cache.get("resolution-1", "https://embed.test/e/abc")!;
    expect(second.url).toContain("media.unknown.test");
    expect(second.requiredHeaders!.Origin).toBe("https://embed.test");
  });

  it("rejects already stale leases and prunes expired entries", () => {
    let now = NOW;
    const cache = new ResolutionLeaseCache({ now: () => now });
    expect(cache.put(meta({ refresh_after: NOW, expires_at: NOW + 1_000 }))).toBe(false);
    cache.put(meta({ resolution_id: "fresh", refresh_after: NOW + 100, expires_at: NOW + 200 }));
    now = NOW + 100;
    expect(cache.cleanup()).toBe(1);
    expect(cache.size).toBe(0);
  });
});

describe("ResolutionCoordinator", () => {
  it("completa timing e id para una resolución renovable proveniente de embed", async () => {
    const locator = "https://embed.test/e/renewable";
    const coordinator = new ResolutionCoordinator(async () => ({
      url: "https://cdn.test/master.m3u8?t=opaque",
      original_url: locator,
      resolved: true,
      type: "direct",
      provider: "Servidor",
      is_refreshable: true,
      canonical_locator: locator,
    }), { now: () => NOW });

    const resolved = await coordinator.resolve(locator);
    expect(resolved.resolution_id).toBeTruthy();
    expect(resolved.refresh_after).toBeGreaterThan(NOW);
    expect(resolved.expires_at).toBeGreaterThan(resolved.refresh_after!);
    expect(coordinator.getByResolutionId(resolved.resolution_id!, locator)).toBeDefined();
  });

  it("recuerda una resolución especializada bajo el localizador estable de la página", () => {
    const locator = "https://www.cinecalidad.am/ver-pelicula/demo/";
    const coordinator = new ResolutionCoordinator(async () => {
      throw new Error("no debe volver a resolver");
    }, { now: () => NOW });
    const remembered = coordinator.rememberResolved({
      url: "https://s9.vimeos.net/hls/demo/master.m3u8?t=opaque",
      original_url: "https://s9.vimeos.net/hls/demo/master.m3u8?t=opaque",
      canonical_locator: locator,
      resolved: true,
      type: "direct",
      provider: "Vimeos",
      requiredHeaders: { Referer: "https://www.cinecalidad.am/" },
      is_proxyable: true,
      is_refreshable: true,
    }, locator);

    expect(remembered.resolution_id).toBeTruthy();
    expect(remembered.original_url).toBe(locator);
    expect(coordinator.getByResolutionId(remembered.resolution_id!, locator)?.url).toContain("vimeos.net");
    expect(coordinator.getByResolutionId(remembered.resolution_id!, remembered.url)).toBeUndefined();
  });

  it("autoriza una página después de extraer su URL firmada temporal", () => {
    const pageLocator = "https://www.cinecalidad.am/ver-pelicula/rotating-token/";
    const signedLocator = "https://s9.vimeos.net/hls/rotating/master.m3u8?t=opaque";
    const coordinator = new ResolutionCoordinator(async () => {
      throw new Error("no debe volver a resolver");
    }, { now: () => NOW });

    const remembered = coordinator.rememberResolved({
      url: signedLocator,
      original_url: signedLocator,
      canonical_locator: signedLocator,
      resolved: true,
      type: "direct",
      provider: "Vimeos",
      is_proxyable: true,
      is_refreshable: true,
    }, pageLocator);

    expect(remembered.original_url).toBe(pageLocator);
    expect(remembered.canonical_locator).toBe(signedLocator);
    expect(coordinator.getByResolutionId(remembered.resolution_id!, pageLocator)?.url).toBe(signedLocator);
  });

  it("deduplicates concurrent resolution and reuses fresh metadata by original locator", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const coordinator = new ResolutionCoordinator(async (locator) => {
      calls += 1;
      await gate;
      return meta({ original_url: locator, resolution_id: `resolved-${calls}`, generation: `resolved-${calls}` });
    }, { now: () => NOW });

    const firstPromise = coordinator.resolve("https://embed.test/e/shared");
    const secondPromise = coordinator.resolve("https://embed.test/e/shared");
    release();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    const third = await coordinator.resolve("https://embed.test/e/shared");

    expect(calls).toBe(1);
    expect(first.resolution_id).toBe(second.resolution_id);
    expect(third.resolution_id).toBe(first.resolution_id);
    expect(first).not.toBe(second);
  });

  it("refreshes after refresh_after and exposes only locator-authorized id lookup", async () => {
    let now = NOW;
    let calls = 0;
    const locator = "https://embed.test/e/refresh";
    const coordinator = new ResolutionCoordinator(async (originalUrl) => {
      calls += 1;
      return meta({
        original_url: originalUrl,
        resolution_id: `generation-${calls}`,
        generation: `generation-${calls}`,
        resolved_at: now,
        refresh_after: now + 10,
        expires_at: now + 20,
      });
    }, { now: () => now });

    const first = await coordinator.resolve(locator);
    expect(coordinator.getByResolutionId(first.resolution_id, locator)).toBeDefined();
    expect(coordinator.getByResolutionId(first.resolution_id, first.url)).toBeUndefined();
    now += 10;
    const second = await coordinator.resolve(locator);

    expect(calls).toBe(2);
    expect(second.resolution_id).toBe("generation-2");
  });

  it("does not share mutable metadata between callers", async () => {
    const locator = "https://embed.test/e/immutable";
    const coordinator = new ResolutionCoordinator(async (originalUrl) => meta({
      original_url: originalUrl,
      requiredHeaders: { Referer: originalUrl },
    }), { now: () => NOW });

    const first = await coordinator.resolve(locator);
    first.url = "https://mutated.test/video.m3u8";
    first.requiredHeaders!.Referer = "mutated";
    const second = await coordinator.resolve(locator);

    expect(second.url).toContain("media.unknown.test");
    expect(second.requiredHeaders!.Referer).toBe(locator);
  });
});
