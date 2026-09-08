import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbedResolvers } from "../../resolvers";
import { LatAnimeAdapter, parseLatAnimeSeason } from "./LatAnimeAdapter";

function player(url: string): string {
  return Buffer.from(url, "utf8").toString("base64");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("LatAnimeAdapter", () => {
  it("detects explicit season markers without confusing episode numbers", () => {
    expect(parseLatAnimeSeason("serie-temporada-2-episodio-4")).toBe(2);
    expect(parseLatAnimeSeason("serie-s02e04")).toBe(2);
    expect(parseLatAnimeSeason("serie-episodio-4")).toBeUndefined();
  });

  it("preserves a season marker on extracted episode links", () => {
    const adapter = new LatAnimeAdapter() as any;
    const html = `
      <a href="https://latanime.org/ver/demo-temporada-2-episodio-4">Temporada 2 - Capitulo 4</a>
      <a href="https://latanime.org/ver/demo-episodio-5">Capitulo 5</a>
    `;
    const episodes = adapter.extractEpisodes(html, "https://latanime.org/anime/demo");
    expect(episodes).toEqual([
      expect.objectContaining({ number: 4, season: 2 }),
      expect.objectContaining({ number: 5 }),
    ]);
    expect(episodes[1].season).toBeUndefined();
  });

  it("keeps later LatAnime candidates and drops a resolver-confirmed stale embed", async () => {
    const adapter = new LatAnimeAdapter();
    const urls = [
      "https://uqload.com/embed-stale.html",
      "https://uqload.com/embed-live-2.html",
      "https://uqload.com/embed-live-3.html",
      "https://uqload.com/embed-live-4.html",
      "https://uqload.com/embed-live-5.html",
      "https://uqload.com/embed-live-6.html",
    ];
    const html = urls.map((url) => `<button data-player="${player(url)}"></button>`).join("");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(html, { status: 200 })));
    vi.spyOn(EmbedResolvers, "resolve").mockImplementation(async (url) =>
      url.includes("stale") ? "" : url,
    );

    const result = await adapter.extractStream("https://latanime.org/ver/demo-1");
    expect(result.all_available_streams).toHaveLength(5);
    expect(result.all_available_streams).not.toContain(urls[0]);
    expect(result.all_available_streams).toEqual(urls.slice(1, 6));
  });
});
