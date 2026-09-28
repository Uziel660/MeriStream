import { describe, expect, it, vi } from "vitest";

vi.mock("anime-sdk", () => {
  class FakeHttpClient {
    constructor(_options?: unknown) {}
  }

  class FakeProvider {
    id: string;

    constructor(_http: unknown) {
      this.id = this.constructor.name.replace("Fake", "").toLowerCase();
    }

    async search() {
      return [{ id: `${this.id}:show` }];
    }

    async fetchContentUnits() {
      return [{ id: `${this.id}:show/1`, number: 1 }];
    }

    async resolveStream() {
      return {
        type: "video",
        streams: [{ sourceUrl: "https://cdn.example.test/episode/master.m3u8?token=jit", isHLS: true, quality: "1080p" }],
      };
    }
  }

  return {
    AllmangaProvider: class FakeAllmangaProvider extends FakeProvider {
      constructor(http: unknown) { super(http); this.id = "allmanga"; }
    },
    AnimeParadiseProvider: class FakeAnimeParadiseProvider extends FakeProvider {
      constructor(http: unknown) { super(http); this.id = "animeparadise"; }
    },
    GogoanimeProvider: class FakeGogoanimeProvider extends FakeProvider {
      constructor(http: unknown) { super(http); this.id = "gogoanime"; }
    },
    MegaPlayProvider: class FakeMegaplayProvider extends FakeProvider {
      constructor(http: unknown) { super(http); this.id = "megaplay"; }
    },
    HttpClient: FakeHttpClient,
  };
});

import { AnimeSdkClient } from "./animeSdkClient";

describe("AnimeSdkClient in-process fallback", () => {
  it("returns JIT media with a stable episode locator", async () => {
    const client = new AnimeSdkClient(null, ["megaplay"]);
    const sources = await client.resolve({
      tmdbId: 1429,
      kind: "anime",
      title: "Attack on Titan",
      season: 1,
      episode: 1,
    });

    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({
      provider: "anime-sdk:megaplay:sub",
      streamType: "hls",
      quality: "1080p",
      canonicalLocator: "anime-sdk:megaplay:megaplay:show:1",
    });
    expect(sources[0].url).toContain("token=jit");
    expect(sources[0].expiresAt).toBeNull();
  });

  it("does not resolve non-anime requests through the anime adapter", async () => {
    const client = new AnimeSdkClient(null, ["megaplay"]);
    await expect(client.resolve({ tmdbId: 550, kind: "movie", title: "Fight Club" })).resolves.toEqual([]);
  });
});
