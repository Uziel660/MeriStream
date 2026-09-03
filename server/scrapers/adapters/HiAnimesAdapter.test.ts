import { afterEach, describe, expect, it, vi } from "vitest";
import { HiAnimesAdapter } from "./HiAnimesAdapter";

const anime = {
  title: "Your Name.",
  English: "Your Name.",
  Japanese: "Kimi no Na wa.",
  slug: "your-name.-wdzkfy",
  Type: "Movie",
  Aired: "Aug 26, 2016",
  Score: "8.83",
  Status: "Finished Airing",
  synopsis: "A story about two teenagers.",
  image: "https://cdn.example/poster.jpg",
  landScapeImage: "https://cdn.example/backdrop.jpg",
  genres: ["Drama"],
  episodes: [{
    episodeNumber: 1,
    title: "Your Name. Episode 1",
    slug: "your-name-episode-1-7642rk",
    link: {
      sub: ["https://zokoanime.video/stream/mal/32281/1/sub"],
      dub: ["https://megaplay.buzz/stream/s-2/57910/dub"],
    },
  }],
};

describe("HiAnimesAdapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps a paginated API catalog without scraping the UI shell", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://animehot.cc/api/filter");
      return new Response(JSON.stringify({ total: 21, page: 1, limit: 20, totalPages: 2, results: [anime] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new HiAnimesAdapter().analyze("https://hianimes.se/filter?type=Movie&page=1", "catalog");
    expect(result.page_type).toBe("catalog");
    expect(result.content_type).toBe("movie");
    expect(result.catalog_items[0]).toMatchObject({ title: "Your Name.", kind: "movie", year: 2016, rating: 8.83 });
    expect(result.next_page_url).toContain("page=2");
  });

  it("keeps sub/dub sources attached to the canonical episode URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/anime/your-name.-wdzkfy")) {
        return new Response(JSON.stringify({ anime }), { status: 200 });
      }
      throw new Error(`unexpected ${url}`);
    }));

    const result = await new HiAnimesAdapter().analyze("https://hianimes.se/details/your-name.-wdzkfy", "detail");
    expect(result.content_type).toBe("movie");
    expect(result.episodes).toHaveLength(1);
    expect(result.episodes[0]?.url).toContain("/watch/your-name-episode-1-7642rk");
    expect(result.episodes[0]?.sources).toEqual([
      expect.objectContaining({ link_type: "page", language: "sub", source_site: "zokoanime.video" }),
      expect.objectContaining({ link_type: "page", language: "dub", source_site: "megaplay.buzz" }),
    ]);
  });
});
