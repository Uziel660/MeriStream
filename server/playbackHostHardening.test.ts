import { describe, expect, it } from "vitest";
import { DeliveryPlanner } from "./deliveryPlanner";
import { buildPlaybackHeaders, hasExplicitHostProfile } from "./hostProfiles";
import type { ResolvedStreamMeta } from "./resolvers";

const directMeta = (url: string): ResolvedStreamMeta => ({
  url, original_url: url, resolved: true, type: "direct", provider: "test",
  is_proxyable: true, is_refreshable: false,
});

describe("special-host playback hardening", () => {
  it("forces Zilla HLS through proxy", () => {
    const url = "https://player.zilla-networks.com/m3u8/0123456789abcdef0123456789abcdef";
    expect(hasExplicitHostProfile(url)).toBe(true);
    expect(new DeliveryPlanner().classify(directMeta(url))).toBe("proxy_required");
  });

  it("forces Megaplay CDN through proxy", () => {
    const url = "https://edge.imgnex.top/master.m3u8";
    expect(hasExplicitHostProfile(url)).toBe(true);
    expect(new DeliveryPlanner().classify(directMeta(url))).toBe("proxy_required");
  });

  it("uses Megaplay CDN Referer instead of stale resolver Referer", () => {
    const result = buildPlaybackHeaders(
      "https://edge.imgnex.top/master.m3u8",
      "https://anipulse.to/watch/123",
      { Referer: "https://anipulse.to/", "X-Resolver-Test": "kept" },
    );
    expect(result.headers.Referer).toBe("https://megaplay.buzz/");
    expect(result.headers["X-Resolver-Test"]).toBe("kept");
    expect(result.headers["User-Agent"]).toContain("Chrome/");
  });

  it("applies Zilla WAF headers and removes forbidden Referer", () => {
    const result = buildPlaybackHeaders(
      "https://player.zilla-networks.com/segs/part-1.ts",
      "https://animeav1.com/media/example/1",
      { Referer: "https://animeav1.com/" },
    );
    expect(result.headers["Sec-Fetch-Site"]).toBe("same-origin");
    expect(result.headers["Sec-Fetch-Mode"]).toBe("cors");
    expect(result.headers.Accept).toBe("*/*");
    expect(result.headers.Referer).toBeUndefined();
  });

  it("keeps resolver headers authoritative for unknown hosts", () => {
    const result = buildPlaybackHeaders(
      "https://unknown.example/video.m3u8",
      "https://origin.example/",
      { Referer: "https://required.example/", Authorization: "Bearer test" },
    );
    expect(result.headers.Referer).toBe("https://required.example/");
    expect(result.headers.Authorization).toBe("Bearer test");
  });
});
