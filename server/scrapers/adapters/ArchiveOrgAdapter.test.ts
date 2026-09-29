import { afterEach, describe, expect, it, vi } from "vitest";
import { ArchiveOrgAdapter } from "./ArchiveOrgAdapter";

describe("ArchiveOrgAdapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the Archive advanced-search API for the movies catalog", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      response: {
        docs: [
          { identifier: "his_girl_friday", title: "His Girl Friday", year: 1940 },
          { identifier: "night_of_the_living_dead", title: "Night of the Living Dead" },
        ],
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new ArchiveOrgAdapter().analyze("https://archive.org/details/movies?page=2", "catalog");

    expect(result.page_type).toBe("catalog");
    expect(result.content_type).toBe("open_archive");
    expect(result.catalog_items).toEqual([
      expect.objectContaining({
        title: "His Girl Friday",
        url: "https://archive.org/details/his_girl_friday",
        kind: "open_archive",
        year: 1940,
      }),
      expect.objectContaining({
        title: "Night of the Living Dead",
        url: "https://archive.org/details/night_of_the_living_dead",
        year: null,
      }),
    ]);
    expect(fetchMock.mock.calls[0][0]).toContain("page=2");
    expect(fetchMock.mock.calls[0][0]).toContain("mediatype%3Amovies");
  });
});
