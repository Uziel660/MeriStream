import { describe, expect, it, vi, afterEach } from "vitest";
import { LaMovieAdapter } from "./LaMovieAdapter";

function response(body: string, status = 200): any {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => JSON.parse(body),
    body: { cancel: async () => undefined },
  };
}

describe("LaMovieAdapter verified WordPress mirrors", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads the mirror catalog and resolves Dooplay player servers without persisting signed media", async () => {
    const detail = `<!doctype html><link rel="shortlink" href="https://lamovie.online/?p=42"><a data-post="42" data-nume="1" data-type="movie"></a><a data-post="42" data-nume="2" data-type="movie"></a>`;
    const catalog = `<article class="dpu-archive-item"><a href="https://lamovie.online/peliculas/yo-soy-bolt/" title="Yo soy Bolt"><img src="/poster.jpg" alt="Yo soy Bolt"></a></article>`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        const body = String(init.body || "");
        const nume = new URLSearchParams(body).get("nume");
        return response(JSON.stringify({ embed_url: nume === "1" ? "https://cdn.example/bolt-1.mp4" : "https://cdn.example/bolt-2.mp4" }));
      }
      if (url.includes("/peliculas/yo-soy-bolt/")) return response(detail);
      if (url.includes("/peliculas")) return response(catalog);
      return response("", 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new LaMovieAdapter();
    const listing = await adapter.analyze("https://lamovie.online/peliculas/", "catalog");
    expect(listing.catalog_items).toHaveLength(1);
    expect(listing.catalog_items[0].url).toBe("https://lamovie.online/peliculas/yo-soy-bolt/");

    const streams = await adapter.extractStream("https://lamovie.online/peliculas/yo-soy-bolt/");
    expect(streams.all_available_streams).toEqual([
      "https://cdn.example/bolt-1.mp4",
      "https://cdn.example/bolt-2.mp4",
    ]);
    expect(streams.all_available_streams.some((url) => /[?&](token|expires|sig)=/i.test(url))).toBe(false);
  });

  it("resolves a modern anime episode through the stable playback API when no code is present", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/playback/anime/136342?season=1&episode=1")) {
        return response(JSON.stringify({
          embeds: [
            { url: "https://vimeos.net/embed-anime-episode.html", lang: "Latino" },
            { url: "https://goodstream.one/embed-anime-episode.html", lang: "Latino" },
          ],
        }));
      }
      return response("", 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new LaMovieAdapter();
    const streams = await adapter.extractStream(
      "https://lamovie.org/episodio/disney-twisted-wonderland-la-serie-temporada-1-episodio-1/?tmdb_id=136342&season=1&episode=1",
    );

    expect(streams.all_available_streams).toEqual([
      "https://vimeos.net/embed-anime-episode.html",
      "https://goodstream.one/embed-anime-episode.html",
    ]);
    expect(streams.all_available_streams.some((url) => /[?&](token|expires|sig)=/i.test(url))).toBe(false);
  });
});
