import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { isTioPlusPageUrl, resolveTioPlusPage } from "../../server/platformPageResolvers";
import { DoramasflixAdapter } from "../../server/scrapers/adapters/DoramasflixAdapter";
import { TioPlusAdapter } from "../../server/scrapers/adapters/TioPlusAdapter";
import { classifySourceKind, parseStreamExpiry } from "../../server/resolutionMetadata";
import { buildNormalizedEpisodes, syncEpisodeSources } from "../../server/showService";
import { prisma } from "../../server/db";

describe("E2E R5: Scrapers & Ephemeral Stream Integrity Suite", () => {
  const TEST_PREFIX = `e2e_r5_${Date.now()}`;
  const createdMediaItemIds: string[] = [];

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (createdMediaItemIds.length > 0) {
      await prisma.sourceLink.deleteMany({
        where: { media_episode: { media_item_id: { in: createdMediaItemIds } } },
      });
      await prisma.mediaEpisode.deleteMany({ where: { media_item_id: { in: createdMediaItemIds } } });
      await prisma.mediaItem.deleteMany({ where: { id: { in: createdMediaItemIds } } });
      createdMediaItemIds.length = 0;
    }
  });

  // ==========================================
  // TIER 1: FEATURE COVERAGE (>=5 tests)
  // ==========================================

  it("T1.1: TioPlus adapter identifies canonical pages across supported domains", () => {
    expect(isTioPlusPageUrl("https://tioplus.app/pelicula/avatar-2/")).toBe(true);
    expect(isTioPlusPageUrl("https://www.tioplus.app/serie/stranger-things/season/1/episode/1")).toBe(true);
    expect(isTioPlusPageUrl("https://tioplus.app/peliculas/gladiator-2")).toBe(true);
    expect(isTioPlusPageUrl("https://unrelated-domain.com/movie/avatar")).toBe(false);
  });

  it("T1.2: Doramasflix adapter uses GraphQL queries and separates doramas from movies", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body || "{}"));
      if (url.includes("doramasflix.io") || body.query?.includes("paginationDorama")) {
        return new Response(JSON.stringify({
          data: {
            paginationDorama: {
              items: [
                { name_es: "Aterrizaje de Emergencia en tu Corazón", slug: "crash-landing-on-you", poster_path: "/cloy.jpg" },
              ],
            },
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("Not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new DoramasflixAdapter();
    const result = await adapter.analyze("https://doramasflix.io/doramas?page=1", "catalog");
    expect(result.source_domain).toBe("doramasflix.io");
    expect(result.catalog_items.length).toBeGreaterThanOrEqual(1);
    expect(result.catalog_items[0].title).toBe("Aterrizaje de Emergencia en tu Corazón");
    expect(result.catalog_items[0].kind).toBe("series");
  });

  it("T1.3: Signed/expiring playback URLs are detected as ephemeral streams", () => {
    const signedUrl1 = "https://cdn.example.com/master.m3u8?expires=1800000000";
    const signedUrl2 = "https://s1.vimeos.net/master.m3u8?s=1800000000&e=3600";
    const signedUrl3 = "https://edge.acek-cdn.com/stream.m3u8?token=opaque_token_abc";
    const canonicalPage = "https://tioplus.app/pelicula/interstellar/";

    expect(classifySourceKind(signedUrl1)).toBe("ephemeral_direct");
    expect(classifySourceKind(canonicalPage)).toBe("page");

    // parseStreamExpiry identifies time limit
    const expiry1 = parseStreamExpiry(signedUrl1);
    expect(expiry1?.expiresAt).toBe(1800000000 * 1000);

    const expiry2 = parseStreamExpiry(signedUrl2);
    expect(expiry2?.expiresAt).toBe(1800003600 * 1000);
  });

  it("T1.4: Ephemeral signed HLS URLs are rejected from permanent database storage", async () => {
    // Media item
    const mediaItem = await prisma.mediaItem.create({
      data: {
        title: `${TEST_PREFIX}_Canonical_Only`,
        normalized_title: `${TEST_PREFIX}_canonical_only`,
        base_normalized_title: `${TEST_PREFIX}_canonical_only`,
        kind: "movie",
      },
    });
    createdMediaItemIds.push(mediaItem.id);

    const sources = [
      { url: "https://tioplus.app/pelicula/avatar-2/", source_site: "tioplus" }, // canonical page
      { url: "https://cdn.example.com/stream.m3u8?expires=1800000000", source_site: "tioplus" }, // ephemeral
    ];

    const added = await syncEpisodeSources(mediaItem.id, 1, 1, sources, "tioplus");
    // Only the canonical page is kept as a permanent source link; ephemeral signed HLS is dropped
    expect(added).toBe(1);
  });

  it("T1.5: On-demand JIT resolution extracts playable stream candidates from canonical pages", async () => {
    const canonicalUrl = "https://tioplus.app/pelicula/avatar-test/";

    const mockFetcher = vi.fn(async (url: string) => {
      if (url.includes("/pelicula/avatar-test/")) {
        return `
          <html>
            <body>
              <button class="server-btn" data-video="aHR0cHM6Ly9tZWRpYS50aW9wbHVzLm5ldC9kaXJlY3QvYXZhdGFyLm1wNA==">Servidor 1</button>
            </body>
          </html>
        `;
      }
      return null;
    });

    const resolution = await resolveTioPlusPage(canonicalUrl, {
      htmlFetcher: mockFetcher,
      streamExtractor: async () => ({
        stream_url: "https://media.tioplus.net/direct/avatar.mp4",
        all_available_streams: ["https://media.tioplus.net/direct/avatar.mp4"],
      }),
    });

    expect(resolution).toBeDefined();
    expect(resolution.provider).toBe("TioPlus");
    expect(resolution.url).toBe("https://media.tioplus.net/direct/avatar.mp4");
  });

  // ==========================================
  // TIER 2: BOUNDARY & CORNER CASES (>=5 tests)
  // ==========================================

  it("T2.1: TioPlus adapter filters out unplayable SPA hosts (strp2p, 4meplayer, upns)", () => {
    const adapter = new TioPlusAdapter();
    const unplayable1 = "https://strp2p.com/player/xyz";
    const unplayable2 = "https://4meplayer.pro/embed/123";
    const unplayable3 = "https://upns.pro/v/token";

    // Private method isUnplayablePlayerUrl checked via extractStream filtering
    expect((adapter as any).isUnplayablePlayerUrl(unplayable1)).toBe(true);
    expect((adapter as any).isUnplayablePlayerUrl(unplayable2)).toBe(true);
    expect((adapter as any).isUnplayablePlayerUrl(unplayable3)).toBe(true);

    const playable = "https://vidhideplus.com/v/abc12345";
    expect((adapter as any).isUnplayablePlayerUrl(playable)).toBe(false);
  });

  it("T2.2: Drops dead or blocked host patterns (cfglobalcdn, yourupload, streamtape)", () => {
    const adapter = new TioPlusAdapter();
    expect((adapter as any).isUnplayablePlayerUrl("https://cfglobalcdn.com/embed/123")).toBe(true);
    expect((adapter as any).isUnplayablePlayerUrl("https://www.yourupload.com/watch/456")).toBe(true);
    expect((adapter as any).isUnplayablePlayerUrl("https://streamtape.com/e/789")).toBe(true);
  });

  it("T2.3: Expired token timestamps are detected as already expired", () => {
    // Epoch timestamp from past (year 2020)
    const expiredPastUrl = "https://s1.example.com/master.m3u8?expires=1577836800";
    const expiry = parseStreamExpiry(expiredPastUrl);
    expect(expiry).not.toBeNull();
    expect(expiry?.expiresAt).toBe(1577836800 * 1000);
    expect(expiry!.expiresAt < Date.now()).toBe(true); // Expired in past
  });

  it("T2.4: Doramasflix GraphQL error responses are handled without process crash", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      return new Response(JSON.stringify({
        errors: [{ message: "Internal server error in GraphQL schema resolver" }],
      }), { status: 500, headers: { "Content-Type": "application/json" } });
    }));

    const adapter = new DoramasflixAdapter();
    await expect(adapter.analyze("https://doramasflix.io/doramas?page=1", "catalog")).rejects.toThrow();
  });

  it("T2.5: Ephemeral URLs do not contaminate normalized episodes legacy source_url", () => {
    const signedUrl = "https://s1.vimeos.net/master.m3u8?s=1800000000&e=3600";
    const canonicalPage = "https://tioplus.app/pelicula/matrix/";

    // Standalone ephemeral without canonical origin is rejected
    const standalone = buildNormalizedEpisodes({ title: "Solo Ephemeral", detected_streams: [signedUrl] }, "movie");
    expect(standalone).toEqual([]);

    // Ephemeral accompanying canonical origin is filtered so only canonical origin remains
    const withCanonical = buildNormalizedEpisodes({
      title: "With Origin",
      detected_streams: [signedUrl],
      sources: [{ url: canonicalPage, source_site: "tioplus" }],
    }, "movie");

    expect(withCanonical).toHaveLength(1);
    expect(withCanonical[0].url).toBe(canonicalPage);
    expect(withCanonical[0].sources.map((s) => s.url)).toEqual([canonicalPage]);
  });
});
