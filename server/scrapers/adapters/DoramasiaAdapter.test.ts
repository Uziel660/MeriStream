import { afterEach, describe, expect, it, vi } from "vitest";
import { DoramasiaAdapter } from "./DoramasiaAdapter";
import { EmbedResolvers } from "../../resolvers";

const jsonResponse = (payload: unknown) => new Response(JSON.stringify(payload), {
  status: 200,
  headers: { "content-type": "application/json" },
});

describe("DoramasiaAdapter", () => {
  afterEach(() => vi.restoreAllMocks());

  it("accepts only Doramasia hosts", () => {
    const adapter = new DoramasiaAdapter();
    expect(adapter.canHandle("https://doramasia.com/doramas")).toBe(true);
    expect(adapter.canHandle("https://www.doramasia.com/peliculas")).toBe(true);
    expect(adapter.canHandle("https://evil-doramasia.com/doramas")).toBe(false);
  });

  it("reads paginated catalog items through GraphQL and keeps canonical URLs", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({
      data: {
        paginationDorama: {
          pageInfo: { currentPage: 1, pageCount: 30, hasNextPage: true },
          items: [
            { slug: "masked-lover", name: "The Masked Lover", name_es: "Amante Enmascarado", first_air_date: "2026-08-01", poster_path: "/poster.jpg" },
            ...Array.from({ length: 99 }, (_, index) => ({ slug: `series-${index}`, name: `Series ${index}`, name_es: `Serie ${index}` })),
            { slug: "masked-lover", name: "duplicate", name_es: "duplicate" },
          ],
        },
      },
    }));

    const result = await new DoramasiaAdapter().analyze("https://doramasia.com/doramas?page=1", "catalog");
    expect(result.catalog_items).toHaveLength(100);
    expect(result.catalog_items[0]).toMatchObject({
      title: "Amante Enmascarado",
      url: "https://doramasia.com/doramas/masked-lover",
      year: 2026,
      kind: "series",
    });
    expect(result.next_page_url).toBe("https://doramasia.com/doramas?page=2");
  });

  it("imports only currently online episodes when the API exposes count_links", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ data: { detailDorama: {
        _id: "serie-1", name: "Series", name_es: "Serie", slug: "series", tmdb_id: 123,
        first_air_date: "2025-01-01", isFinish: false, seasons: [{ season_number: 1 }],
        genres: [{ name: "Drama" }], poster_path: "/poster.jpg", backdrop_path: "/backdrop.jpg",
      } } }))
      .mockResolvedValueOnce(jsonResponse({ data: { paginationEpisode: {
        pageInfo: { pageCount: 1 },
        items: [
          { slug: "series-1x1", name: "1x1", name_es: "1x1", episode_number: 1, season_number: 1, count_links: 3 },
          { slug: "series-1x2", name: "1x2", name_es: "1x2", episode_number: 2, season_number: 1, count_links: null },
        ],
      } } }));

    const result = await new DoramasiaAdapter().analyze("https://doramasia.com/doramas/series", "detail");
    expect(result.episodes).toHaveLength(1);
    expect(result.episodes[0].url).toBe("https://doramasia.com/capitulos/series-1x1");
    expect(result.tmdb_id).toBe(123);
  });

  it("decodes signed links just in time, resolves supported servers and drops dead hosts", async () => {
    const token = (link: string) => {
      const payload = Buffer.from(JSON.stringify({ link: Buffer.from(link).toString("base64") })).toString("base64url");
      return `https://embedshortener.co/e/header.${payload}.signature`;
    };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ data: { detailEpisode: {
        _id: "episode-1", name: "Episode", name_es: "Episodio", episode_number: 1, season_number: 1,
      } } }))
      .mockResolvedValueOnce(jsonResponse({ data: { getEpisodeLinks: { links_online: [
        { server: "Filemoon", link: token("https://filemoon.sx/e/dead") },
        { server: "Primeload", is_recommended: true, link: token("https://primeload.co/embed/good") },
      ] } } }))
      .mockResolvedValueOnce(new Response("#EXTM3U\n", { status: 200 }));
    vi.spyOn(EmbedResolvers, "resolveWithMeta").mockResolvedValue({
      resolved: true,
      url: "https://cdn.example/video/master.m3u8",
      type: "direct",
      provider: "Primeload",
      is_proxyable: true,
      is_refreshable: true,
    });

    const result = await new DoramasiaAdapter().extractStream("https://doramasia.com/capitulos/series-1x1");
    expect(result.stream_url).toBe("https://cdn.example/video/master.m3u8");
    expect(result.all_available_streams).toEqual(["https://cdn.example/video/master.m3u8"]);
    expect(result.all_available_streams.some((url) => /filemoon/i.test(url))).toBe(false);
  });
});
